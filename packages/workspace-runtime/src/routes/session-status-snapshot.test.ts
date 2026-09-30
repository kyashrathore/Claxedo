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

  it("a stored retry, which keeps only its kind, reads as retrying without an invented attempt or countdown", () => {
    expect(sessionStatusSnapshot([{ id: "retry-2", status: "retry" }])).toEqual({
      "retry-2": { type: "retry", message: "The harness is retrying its model request" },
    })
  })

  it("surfaces persisted recovery markers so reload can show stale ACP turns", () => {
    expect(sessionStatusSnapshot([
      { id: "rec-1", status: "recovering", recovery_error: "ACP process restarted" },
      { id: "err-1", status: "error", recovery_error: "ACP process restarted" },
    ])).toEqual({
      "rec-1": {
        type: "recovering",
        kind: "process_restart",
        message: "ACP process restarted",
      },
    })
  })
})
