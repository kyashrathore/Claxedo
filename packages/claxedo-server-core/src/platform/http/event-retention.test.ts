import { describe, expect, test } from "vitest"
import type { ControlPlaneEvent } from "../runtime/lib/bus"
import { isRetainedControlPlaneEvent, supersededControlPlaneEventKey } from "./event-retention"

const status = (ownerUserId: string, sessionId: string): ControlPlaneEvent => ({
  type: "session.status.changed",
  ownerUserId,
  orgId: "org_a",
  sessionId,
  workspaceId: "ws_1",
  status: "idle",
  awaitingInput: false,
  ts: 1,
})

describe("control-plane event retention", () => {
  test("a status notice stays out of the terminal reserve the doorbells live in", () => {
    expect(isRetainedControlPlaneEvent(status("user_a", "ses_1"))).toBe(false)
    expect(isRetainedControlPlaneEvent({ type: "session.share.changed", phase: "revoked", ownerUserId: "user_a", sessionId: "ses_1", workspaceId: "ws_1", ts: 1 })).toBe(true)
  })

  test("a status notice supersedes the earlier one for the same reader and session only", () => {
    expect(supersededControlPlaneEventKey(status("user_a", "ses_1"))).toBe(supersededControlPlaneEventKey(status("user_a", "ses_1")))
    expect(supersededControlPlaneEventKey(status("user_a", "ses_1"))).not.toBe(supersededControlPlaneEventKey(status("user_b", "ses_1")))
    expect(supersededControlPlaneEventKey(status("user_a", "ses_1"))).not.toBe(supersededControlPlaneEventKey(status("user_a", "ses_2")))
    expect(supersededControlPlaneEventKey({ type: "usage.quota.changed", ts: 1 })).toBeUndefined()
  })
})
