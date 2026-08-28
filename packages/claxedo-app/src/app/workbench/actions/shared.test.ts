import { describe, expect, test } from "bun:test"
import { sessionRefForActionWorkspace } from "./shared"

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
          hosting: "user-hosted",
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
      workspaceKind: "cloud",
    })).toEqual({
      sessionId: "new",
      host: "workspace",
      workspaceId: "ws_signed",
      toolSandbox: {
        kind: "workspace",
        workspaceId: "ws_signed",
        hosting: "cloud",
      },
    })
  })
})
