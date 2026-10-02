import { describe, expect, test } from "bun:test"
import { admitSessionInstructions, SESSION_INSTRUCTIONS_MAX_BYTES } from "./session-instructions"

describe("admitSessionInstructions", () => {
  test("admits an absent block on every channel, including one with no channel at all", () => {
    for (const channel of ["turn-system-prompt", "thread-start", "prompt-prefix", "none"] as const) {
      expect(admitSessionInstructions({ channel, instructions: undefined })).toBeUndefined()
    }
  })

  test("refuses by byte count, not character count", () => {
    const atCap = "🙂".repeat(SESSION_INSTRUCTIONS_MAX_BYTES / 4)
    expect(admitSessionInstructions({ channel: "thread-start", instructions: atCap })).toBeUndefined()
    expect(admitSessionInstructions({ channel: "thread-start", instructions: `${atCap}a` }))
      .toMatchObject({ reason: "too_large" })
  })

  test("names the harness it was asked for when the caller knows it", () => {
    expect(admitSessionInstructions({ harness: "opencode", channel: "none", instructions: "x" })?.message)
      .toBe("Harness opencode has no instruction channel for session instructions")
    expect(admitSessionInstructions({ channel: "none", instructions: "x" })?.message)
      .toBe("This harness has no instruction channel for session instructions")
  })
})
