import { describe, expect, it } from "bun:test"
import { sessionStatusSnapshot } from "./session-status-snapshot"

describe("sessionStatusSnapshot", () => {
  it("keeps live busy and retry statuses", () => {
    expect(sessionStatusSnapshot([
      { id: "busy-1", status: "busy" },
      { id: "retry-1", status: "retry", attempt: 2, message: "rate limited", next: 123 },
    ])).toEqual({
      "busy-1": { type: "busy" },
      "retry-1": { type: "retry", attempt: 2, message: "rate limited", next: 123 },
    })
  })

  it("does not surface persisted recovery markers as live status", () => {
    expect(sessionStatusSnapshot([
      { id: "rec-1", status: "recovering", recovery_error: "ACP process restarted" },
      { id: "err-1", status: "error", recovery_error: "ACP process restarted" },
    ])).toEqual({})
  })
})
