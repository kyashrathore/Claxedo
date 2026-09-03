import { describe, expect, test } from "bun:test"
import { resolveWorkspaceRouteDirectory } from "./route-workspace-directory"
import { controlPlaneCatalogProjects } from "@/features/workspaces/data/workspace-catalog"

describe("resolveWorkspaceRouteDirectory", () => {
  // The route bridge hands this value to every session read the pane makes
  // (`?directory=`, `x-opencode-directory`). For a workspace served by another
  // machine that value must be the workspace's own address; the host's path
  // names a directory that does not exist on whichever server answers.
  test("scopes a relay-backed route by the workspace address, never the host's path", () => {
    const HOST_PATH = "/Users/host/opencode"
    const projects = controlPlaneCatalogProjects({
      workspaces: [{
        workspace_id: "ws_hosted",
        project_id: "proj_hosted",
        access: "user-hosted",
        remote_directory: HOST_PATH,
      }],
    })

    expect(resolveWorkspaceRouteDirectory({ routeKey: "ws_hosted", projects })).toBe("workspace:ws_hosted")
    expect(resolveWorkspaceRouteDirectory({ routeKey: "workspace:ws_hosted", projects }))
      .toBe("workspace:ws_hosted")
  })

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

  test("a non-UUID key the catalog cannot place stands in for itself", () => {
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
