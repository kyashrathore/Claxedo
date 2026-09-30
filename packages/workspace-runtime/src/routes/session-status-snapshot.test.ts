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

  it("marks background work beside the turn's status and lists an idle session that has some", () => {
    const background = new Set(["busy-1", "idle-1"])
    expect(sessionStatusSnapshot([
      { id: "busy-1", status: "busy" },
      { id: "idle-1", status: "idle" },
      { id: "idle-2", status: "idle" },
    ], (sessionId) => background.has(sessionId))).toEqual({
      "busy-1": { type: "busy", backgroundWork: true },
      "idle-1": { type: "idle", backgroundWork: true },
    })
  })
})
