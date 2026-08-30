import { describe, expect, test } from "bun:test"
import { resolveWorkspaceRouteDirectory } from "./route-workspace-directory"

describe("resolveWorkspaceRouteDirectory", () => {
  test("returns catalog directory for a local association UUID route key", () => {
    expect(resolveWorkspaceRouteDirectory({
      routeKey: "5f39af3e-75c4-4392-baaf-574acbbf9db9",
      projects: [{
        id: "project-1",
        worktree: "/Users/me/repo",
        workspaces: {
          "/Users/me/repo": {
            id: "5f39af3e-75c4-4392-baaf-574acbbf9db9",
            directory: "/Users/me/repo",
          },
        },
      }],
    })).toBe("/Users/me/repo")
  })

  test("preserves historical routeKey fallback for non-UUID keys", () => {
    expect(resolveWorkspaceRouteDirectory({
      routeKey: "ws_cloud",
      projects: [],
    })).toBe("ws_cloud")
    expect(resolveWorkspaceRouteDirectory({
      routeKey: "/Users/me/repo",
      projects: [],
    })).toBe("/Users/me/repo")
    expect(resolveWorkspaceRouteDirectory({
      routeKey: "project_opaque",
      projects: [],
    })).toBe("project_opaque")
  })

  test("does not treat an unresolved local association UUID as a cwd", () => {
    expect(resolveWorkspaceRouteDirectory({
      routeKey: "5f39af3e-75c4-4392-baaf-574acbbf9db9",
      projects: [],
    })).toBeUndefined()
  })
})
