import { describe, expect, test } from "bun:test"
import type { PermissionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { sessionVisiblePermissionRequest } from "./session-request-tree"

const sessions = [
  { id: "session-a" },
  { id: "session-a-child", parentID: "session-a" },
  { id: "session-b" },
] as Session[]

const permission = (id: string, sessionID: string): PermissionRequest => ({
  id,
  sessionID,
  permission: "read",
  patterns: [],
  always: [],
  metadata: {},
})

describe("visible session permission request", () => {
  test("waits for persisted permission policy before rendering a manual dock", () => {
    const requests = { "session-a": [permission("perm-a", "session-a")] }

    expect(sessionVisiblePermissionRequest({
      ready: false,
      sessions,
      requests,
      sessionID: "session-a",
    })).toBeUndefined()

    expect(sessionVisiblePermissionRequest({
      ready: true,
      sessions,
      requests,
      sessionID: "session-a",
    })?.id).toBe("perm-a")
  })

  test("never leaks another session's pending request across a switch", () => {
    const requests = {
      "session-a": [permission("perm-a", "session-a")],
      "session-b": [permission("perm-b", "session-b")],
    }

    expect(sessionVisiblePermissionRequest({
      ready: true,
      sessions,
      requests,
      sessionID: "session-b",
    })?.id).toBe("perm-b")
  })
})
