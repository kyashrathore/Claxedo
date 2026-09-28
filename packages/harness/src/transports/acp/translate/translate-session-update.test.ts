import { describe, expect, test } from "bun:test"
import { translateStopReason } from "./translate-session-update"

describe("translateStopReason", () => {
  test("ends a completed prompt with finish", () => {
    for (const stopReason of ["end_turn", "max_tokens", "max_turn_requests"] as const) {
      expect(translateStopReason(stopReason, "session-1")).toEqual([
        { type: "session-status", status: "idle" },
        { type: "finish", sessionId: "session-1" },
      ])
    }
  })

  test("ends a cancelled prompt with cancelled, never finish", () => {
    expect(translateStopReason("cancelled", "session-1")).toEqual([
      { type: "session-status", status: "idle" },
      { type: "cancelled", sessionId: "session-1" },
    ])
  })
})
