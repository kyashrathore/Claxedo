import { workspaceSessionRoute } from "@/platform/identity/route"
import { describe, expect, test } from "bun:test"
import { findProjectForWorkspace, findWorkspaceForDirectory, workspaceDraftRouteForDirectory } from "./shared"

describe("workspace action inventory lookup", () => {
  test("retains the canonical id from an id-keyed local workspace record", () => {
    const projects = () => [
      {
        id: "project-1",
        worktree: "/repo/main",
        workspaces: {
          "workspace-1": {
            id: "workspace-1",
            directory: "/repo/main",
            kind: "local" as const,
          },
        },
      },
    ]

    expect(findProjectForWorkspace(projects, "/repo/main")?.id).toBe("project-1")
    expect(findWorkspaceForDirectory(projects, "/repo/main")).toMatchObject({
      directory: "/repo/main",
      workspaceId: "workspace-1",
    })
    // Directory form even though this workspace HAS a canonical id: every other
    // writer addresses a local workspace by directory, and mixing the two forms
    // flips the :workspaceId param on the next navigation.
    expect(workspaceDraftRouteForDirectory(projects, "/repo/main")).toBe(workspaceSessionRoute("/repo/main"))
  })

  test("still yields a draft route when inventory has no canonical id", () => {
    const projects = () => [{ id: "project-1", worktree: "/repo/main", workspaces: {} }]

    expect(workspaceDraftRouteForDirectory(projects, "/repo/main")).toBe(workspaceSessionRoute("/repo/main"))
  })
})
