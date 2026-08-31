import { describe, expect, test } from "bun:test"
import type { SessionRef } from "@/platform/identity/session-ref"
import { resolveCreatedSessionListWorkspaceId } from "./submit-rail-workspace"

describe("resolveCreatedSessionListWorkspaceId", () => {
  test("uses signed workspace session refs and ws_* input ids", () => {
    expect(resolveCreatedSessionListWorkspaceId({
      sessionRef: sessionRef("session-1", "ws_1"),
      workspaceId: undefined,
      sessionDirectory: "workspace:ws_1",
    })).toBe("ws_1")
    expect(resolveCreatedSessionListWorkspaceId({
      sessionRef: undefined,
      workspaceId: "ws_cloud",
      sessionDirectory: "/repo",
    })).toBe("ws_cloud")
  })

  test("falls through to route ws_* when workspace host ref has no key", () => {
    expect(resolveCreatedSessionListWorkspaceId({
      sessionRef: {
        sessionId: "session-1",
        host: "workspace",
        cwd: "/repo",
      },
      workspaceId: "ws_route",
      sessionDirectory: "/repo",
    })).toBe("ws_route")
  })

  test("skips local UUID associations so rail rows stay directory-scoped", () => {
    expect(resolveCreatedSessionListWorkspaceId({
      sessionRef: undefined,
      workspaceId: "550e8400-e29b-41d4-a716-446655440000",
      sessionDirectory: "/repo",
    })).toBeUndefined()
    expect(resolveCreatedSessionListWorkspaceId({
      sessionRef: undefined,
      workspaceId: undefined,
      sessionDirectory: "workspace:550e8400-e29b-41d4-a716-446655440000",
    })).toBeUndefined()
  })
})

function sessionRef(sessionId: string, workspaceId: string): SessionRef {
  return {
    sessionId,
    host: "workspace",
    workspaceId,
  }
}
