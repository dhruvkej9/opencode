import { NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Schedule, Context } from "effect"
import path from "path"
import type { Agent } from "../agent/agent"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { evaluate } from "@/permission/evaluate"
import { Identifier } from "../id/id"
import { Log } from "../util"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"

const log = Log.create({ service: "truncation" })
const RETENTION = Duration.days(7)
const APPROX_BYTES_PER_TOKEN = 4

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
export const CODEX_MAX_TOKENS = 10_000
export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")

export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

export interface Options {
  maxLines?: number
  maxBytes?: number
  maxTokens?: number
  direction?: "head" | "tail"
}

interface ModelLike {
  api?: {
    id?: string
  }
}

function hasTaskTool(agent?: Agent.Info) {
  if (!agent?.permission) return false
  return evaluate("task", "*", agent.permission).action !== "deny"
}

function approxTokenCount(text: string) {
  return Math.ceil(Buffer.byteLength(text, "utf-8") / APPROX_BYTES_PER_TOKEN)
}

function sliceByByteLimit(text: string, maxBytes: number, fromStart: boolean) {
  if (maxBytes <= 0) return ""
  const chars = Array.from(text)
  const out: string[] = []
  let used = 0
  const items = fromStart ? chars : chars.toReversed()
  for (const char of items) {
    const size = Buffer.byteLength(char, "utf-8")
    if (used + size > maxBytes) break
    out.push(char)
    used += size
  }
  return fromStart ? out.join("") : out.toReversed().join("")
}

function truncateMiddleWithTokenBudget(text: string, maxTokens: number) {
  const totalTokens = approxTokenCount(text)
  if (totalTokens <= maxTokens) {
    return {
      preview: text,
      removed: 0,
    }
  }

  const markerReserve = 32
  const maxBytes = Math.max(0, maxTokens * APPROX_BYTES_PER_TOKEN - markerReserve)
  const left = sliceByByteLimit(text, Math.ceil(maxBytes / 2), true)
  const right = sliceByByteLimit(text, Math.floor(maxBytes / 2), false)
  const keptTokens = approxTokenCount(left) + approxTokenCount(right)
  const removed = Math.max(1, totalTokens - keptTokens)

  return {
    preview: `${left}...${removed} tokens truncated...${right}`,
    removed,
  }
}

function isCodexModel(model?: ModelLike) {
  return model?.api?.id?.toLowerCase().includes("codex") ?? false
}

export function optionsForModel(model?: ModelLike): Options {
  if (!isCodexModel(model)) return {}
  return {
    maxTokens: CODEX_MAX_TOKENS,
    maxLines: Number.MAX_SAFE_INTEGER,
  }
}

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  readonly write: (text: string) => Effect.Effect<string>
  /**
   * Returns output unchanged when it fits within the limits, otherwise writes the full text
   * to the truncation directory and returns a preview plus a hint to inspect the saved file.
   */
  readonly output: (text: string, options?: Options, agent?: Agent.Info) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Truncate") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const cleanup = Effect.fn("Truncate.cleanup")(function* () {
      const cutoff = Identifier.timestamp(
        Identifier.create("tool", "ascending", Date.now() - Duration.toMillis(RETENTION)),
      )
      const entries = yield* fs.readDirectory(TRUNCATION_DIR).pipe(
        Effect.map((all) => all.filter((name) => name.startsWith("tool_"))),
        Effect.catch(() => Effect.succeed([])),
      )
      for (const entry of entries) {
        if (Identifier.timestamp(entry) >= cutoff) continue
        yield* fs.remove(path.join(TRUNCATION_DIR, entry)).pipe(Effect.catch(() => Effect.void))
      }
    })

    const write = Effect.fn("Truncate.write")(function* (text: string) {
      const file = path.join(TRUNCATION_DIR, ToolID.ascending())
      yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
      yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      return file
    })

    const output = Effect.fn("Truncate.output")(function* (text: string, options: Options = {}, agent?: Agent.Info) {
      const maxLines = options.maxLines ?? MAX_LINES
      const maxBytes = options.maxBytes ?? MAX_BYTES
      const maxTokens = options.maxTokens
      const direction = options.direction ?? "head"
      const lines = text.split("\n")
      const totalBytes = Buffer.byteLength(text, "utf-8")
      const totalTokens = typeof maxTokens === "number" ? approxTokenCount(text) : undefined

      if (
        lines.length <= maxLines &&
        (typeof maxTokens === "number" ? totalTokens! <= maxTokens : totalBytes <= maxBytes)
      ) {
        return { content: text, truncated: false } as const
      }

      if (typeof maxTokens === "number") {
        const file = yield* write(text)
        const truncated = truncateMiddleWithTokenBudget(text, maxTokens)
        const hint = hasTaskTool(agent)
          ? `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
          : `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`

        return {
          content: `Total output lines: ${lines.length}\n\n${truncated.preview}\n\n${hint}`,
          truncated: true,
          outputPath: file,
        } as const
      }

      const out: string[] = []
      let i = 0
      let bytes = 0
      let hitBytes = false

      if (direction === "head") {
        for (i = 0; i < lines.length && i < maxLines; i++) {
          const size = Buffer.byteLength(lines[i], "utf-8") + (i > 0 ? 1 : 0)
          if (bytes + size > maxBytes) {
            hitBytes = true
            break
          }
          out.push(lines[i])
          bytes += size
        }
      } else {
        for (i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
          const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
          if (bytes + size > maxBytes) {
            hitBytes = true
            break
          }
          out.unshift(lines[i])
          bytes += size
        }
      }

      const removed = hitBytes ? totalBytes - bytes : lines.length - out.length
      const unit = hitBytes ? "bytes" : "lines"
      const preview = out.join("\n")
      const file = yield* write(text)

      const hint = hasTaskTool(agent)
        ? `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
        : `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`

      return {
        content:
          direction === "head"
            ? `${preview}\n\n...${removed} ${unit} truncated...\n\n${hint}`
            : `...${removed} ${unit} truncated...\n\n${hint}\n\n${preview}`,
        truncated: true,
        outputPath: file,
      } as const
    })

    yield* cleanup().pipe(
      Effect.catchCause((cause) => {
        log.error("truncation cleanup failed", { cause: Cause.pretty(cause) })
        return Effect.void
      }),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )

    return Service.of({ cleanup, write, output })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(NodePath.layer))
