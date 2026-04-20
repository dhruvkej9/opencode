import { describe, expect } from "bun:test"
import { Effect } from "effect"
import * as Truncate from "../../src/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(Truncate.defaultLayer)

describe("tool.truncate", () => {
  it.live("uses Codex token truncation for codex models", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      const text = Array.from({ length: 25_000 }, (_, index) => `token-${index}`).join(" ")
      const result = yield* svc.output(
        text,
        Truncate.optionsForModel({
          api: { id: "gpt-5.2-codex" },
        }),
      )

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("Total output lines: 1")
      expect(result.content).toContain("tokens truncated")
      expect(result.content).not.toContain("bytes truncated")
      expect(result.content).toContain("token-0")
      expect(result.content).toContain("token-24999")
    }),
  )

  it.live("keeps legacy byte truncation for non-codex models", () =>
    Effect.gen(function* () {
      const svc = yield* Truncate.Service
      const text = "a".repeat(80_000)
      const result = yield* svc.output(text)

      expect(result.truncated).toBe(true)
      expect(result.content).toContain("bytes truncated")
    }),
  )
})
