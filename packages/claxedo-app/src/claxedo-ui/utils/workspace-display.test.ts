import { describe, expect, test } from "bun:test"
import {
  projectDisplayName,
  projectWorkspaceDirectories,
  workspaceDisplayName,
  workspaceIsCloud,
  type WorkspaceDisplayProject,
} from "./workspace-display"

const project: WorkspaceDisplayProject = {
  id: "p-1",
  name: "Alpha",
  worktree: "/repo/main",
  sandboxes: ["ws-feature"],
  workspaces: {
    "ws-main": { id: "ws-main", directory: "/repo/main", workspace_name: "main", kind: "cloud" },
    "ws-feature": { id: "ws-feature", directory: "/repo/feature", workspace_name: "feature-auth", kind: "local" },
    "/repo/review": { workspace_name: "review", kind: "cloud" },
  },
}

describe("workspace display helpers", () => {
  test("projectDisplayName prefers explicit project name", () => {
    expect(projectDisplayName(project)).toBe("Alpha")
  })

  test("projectWorkspaceDirectories includes canonical workspace directories", () => {
    expect(projectWorkspaceDirectories(project)).toEqual([
      "/repo/main",
      "/repo/feature",
      "/repo/review",
    ])
  })

  test("workspaceIsCloud uses workspace metadata and main fallback", () => {
    expect(workspaceIsCloud(project, "/repo/main")).toBe(true)
    expect(workspaceIsCloud(project, "/repo/review")).toBe(true)
    expect(workspaceIsCloud(project, "/repo/feature")).toBe(false)
    expect(workspaceIsCloud({ ...project, workspaces: {} }, "/repo/main", { mainIsCloud: true })).toBe(true)
  })

  test("workspaceDisplayName does not include environment labels", () => {
    expect(workspaceDisplayName(project, "/repo/main")).toBe("main")
    expect(workspaceDisplayName(project, "/repo/feature")).toBe("feature-auth")
    expect(workspaceDisplayName(project, "/repo/review")).toBe("review")
  })
})
