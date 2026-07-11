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

  test("projectDisplayName falls back to the worktree folder name when there is no explicit name", () => {
    expect(projectDisplayName({ id: "p", worktree: "/home/user/myapp" })).toBe("myapp")
  })

  test("workspaceDisplayName labels the worktree 'main' when no workspace metadata names it", () => {
    expect(workspaceDisplayName({ id: "p", worktree: "/home/user/myapp" }, "/home/user/myapp")).toBe("main")
  })

  test("workspaceDisplayName falls back to a sandbox directory basename when it has no workspace_name", () => {
    const bare: WorkspaceDisplayProject = {
      id: "p",
      worktree: "/home/user/myapp",
      sandboxes: ["/home/worktrees/myapp/feature-1"],
    }
    expect(workspaceDisplayName(bare, "/home/worktrees/myapp/feature-1")).toBe("feature-1")
  })

  test("workspaceIsCloud is false for a non-main directory with no workspace metadata", () => {
    const bare: WorkspaceDisplayProject = { id: "p", worktree: "/home/user/myapp", sandboxes: ["/home/user/myapp-x"] }
    expect(workspaceIsCloud(bare, "/home/user/myapp-x")).toBe(false)
  })

  test("projectWorkspaceDirectories returns only the worktree when there are no sandboxes", () => {
    expect(projectWorkspaceDirectories({ id: "p", worktree: "/home/user/myapp" })).toEqual(["/home/user/myapp"])
  })

  test("projectWorkspaceDirectories dedupes a sandbox that resolves to the worktree", () => {
    const dupe: WorkspaceDisplayProject = {
      id: "p",
      worktree: "/home/user/myapp",
      sandboxes: ["/home/user/myapp", "/home/user/myapp-feature"],
    }
    expect(projectWorkspaceDirectories(dupe)).toEqual(["/home/user/myapp", "/home/user/myapp-feature"])
  })
})
