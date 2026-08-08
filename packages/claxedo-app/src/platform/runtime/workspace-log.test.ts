import { describe, expect, test } from "bun:test"
import { appendWorkspaceRuntimeLog } from "./workspace-log"

describe("appendWorkspaceRuntimeLog", () => {
  test("appends a row", () => {
    expect(appendWorkspaceRuntimeLog([], "stopped", "Waking workspace runtime...", 12, 1)).toEqual([
      { step: "stopped", message: "Waking workspace runtime...", ts: 1, totalMs: 12 },
    ])
  })

  test("returns the SAME array for a duplicate row, so a store write is a no-op", () => {
    const first = appendWorkspaceRuntimeLog([], "stopped", "Waking workspace runtime...", 12, 1)

    // Identity, not equality: `prepareUserHostedRuntime` re-emits
    // `checking_health` on every retry, and a fresh array each time would
    // re-render the startup view once per attempt.
    expect(appendWorkspaceRuntimeLog(first, "stopped", "Waking workspace runtime...", 12, 2)).toBe(first)
  })

  test("a changed message is a new row, and only the LAST row is compared", () => {
    const first = appendWorkspaceRuntimeLog([], "checking_health", "Checking runtime health...", undefined, 1)
    const second = appendWorkspaceRuntimeLog(first, "checking_health", "Waiting for the host...", undefined, 2)
    const third = appendWorkspaceRuntimeLog(second, "checking_health", "Checking runtime health...", undefined, 3)

    expect(second).not.toBe(first)
    expect(third.map((log) => log.message)).toEqual([
      "Checking runtime health...",
      "Waiting for the host...",
      "Checking runtime health...",
    ])
  })
})
