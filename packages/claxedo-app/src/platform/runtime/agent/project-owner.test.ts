import { describe, expect, test } from "bun:test"
import { isProjectWorktreeDirectory, projectForDirectory } from "./project-owner"

describe("project inventory ownership", () => {
  test("resolves a registered local worktree through its sandbox workspace id", () => {
    const projects = [{
      id: "proj_local",
      worktree: "/repo/main",
      sandboxes: ["workspace_feature"],
      workspaces: {
        workspace_main: {
          id: "workspace_main",
          kind: "local" as const,
          directory: "/repo/main",
        },
        workspace_feature: {
          id: "workspace_feature",
          kind: "local" as const,
          directory: "/worktrees/feature",
        },
      },
    }]

    expect(projectForDirectory(projects, "/worktrees/feature")?.id).toBe("proj_local")
    expect(isProjectWorktreeDirectory(projects[0], "/worktrees/feature")).toBe(true)
    expect(isProjectWorktreeDirectory(projects[0], "/repo/main")).toBe(false)
  })
})
