import { describe, expect, test } from "bun:test"
import { findProjectForWorkspace, missingLocalWorkspace, sessionRefForActionWorkspace } from "./shared"

describe("sessionRefForActionWorkspace", () => {
  test("resolves signed workspace authority through id and directory aliases", () => {
    const projects = () => [{
      id: "project-1",
      worktree: "ws_signed",
      workspaces: {
        ws_signed: {
          id: "ws_signed",
          workspaceId: "ws_signed",
          directory: "/runtime/repo",
          kind: "user-hosted" as const,
        },
      },
    }]

    for (const workspaceDir of ["ws_signed", "/runtime/repo"]) {
      expect(sessionRefForActionWorkspace({ projects, workspaceDir, sessionId: "new" })).toEqual({
        sessionId: "new",
        host: "workspace",
        workspaceId: "ws_signed",
        toolSandbox: {
          kind: "workspace",
          workspaceId: "ws_signed",
          hosting: "machine",
        },
      })
    }
  })

  test("uses explicit connected route authority while the project catalog is sparse", () => {
    expect(sessionRefForActionWorkspace({
      projects: () => [{ id: "project-1", worktree: "ws_signed" }],
      workspaceDir: "ws_signed",
      sessionId: "new",
      workspaceRouteId: "ws_signed",
      hostKind: "provisioner",
    })).toEqual({
      sessionId: "new",
      host: "workspace",
      workspaceId: "ws_signed",
      toolSandbox: {
        kind: "workspace",
        workspaceId: "ws_signed",
        hosting: "provisioner",
      },
    })
  })
})

describe("local worktree lookup", () => {
  test("recognizes a missing checkout whether the caller has its directory or workspace ID", () => {
    const owner = { id: "project", worktree: "/repo/main", sandboxes: ["ws_feature"], workspaces: {
      ws_feature: { id: "ws_feature", directory: "/repo/feature", kind: "local" as const, available: false },
    } }
    for (const ref of ["ws_feature", "/repo/feature"]) {
      expect(findProjectForWorkspace(() => [owner], ref)).toBe(owner)
      expect(missingLocalWorkspace(() => [owner], ref)).toMatchObject({ available: false, projectWorktree: "/repo/main" })
    }
  })
})
