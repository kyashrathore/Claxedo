import { describe, expect, test } from "bun:test"
import { localWorkspaceInProjects, signedWorkspaceFromProjects } from "./signed-workspace"

describe("signed workspace lookup", () => {
  test("matches raw workspace ids from cached project metadata", () => {
    expect(signedWorkspaceFromProjects([
      {
        workspaces: {
          "/tmp/project": {
            workspaceId: "ws_cached",
            kind: "cloud",
            directory: "/tmp/project",
          },
        },
      },
    ], "ws_cached")).toEqual({
      workspaceId: "ws_cached",
      directory: "/tmp/project",
      workspaceName: undefined,
      kind: "cloud",
    })
  })

  test("returns a stable object for repeated lookups in the same project inventory", () => {
    const projects = [{
      workspaces: {
        "/tmp/project": {
          workspaceId: "ws_cached",
          kind: "cloud",
          directory: "/tmp/project",
        },
      },
    }]

    expect(signedWorkspaceFromProjects(projects, "/tmp/project")).toBe(
      signedWorkspaceFromProjects(projects, "/tmp/project"),
    )
  })

  test("normalizes nullable control-plane workspace fields at the inventory boundary", () => {
    expect(signedWorkspaceFromProjects([{
      workspaces: {
        ws_nullable: {
          id: null,
          workspaceId: "ws_nullable",
          kind: "user-hosted",
          directory: null,
          workspace_name: null,
          workspaceName: null,
        },
      },
    }], "ws_nullable")).toEqual({
      workspaceId: "ws_nullable",
      directory: "ws_nullable",
      kind: "user-hosted",
    })
  })

  test("treats a filesystem project's own UUID as local, not relay-backed", () => {
    const projectId = "c4955849-a3c1-4f3e-8481-1fd1bdec3962"
    const worktree = "/private/tmp/claxedo-agent-plugins-real-app/plugins-e2e"
    const projects = [{
      id: projectId,
      worktree,
      workspaces: {
        [worktree]: { id: projectId, directory: worktree, kind: "local" },
      },
    }]

    expect(localWorkspaceInProjects(projects, projectId)).toBe(true)
    expect(localWorkspaceInProjects(projects, worktree)).toBe(true)
    expect(signedWorkspaceFromProjects(projects, projectId)).toBeUndefined()
  })

  test("treats a desktop project UUID as local even when inventory omitted kind: local", () => {
    const projectId = "b0b33e8a-8f25-4ce6-b9a8-e06d31a7caf3"
    const worktree = "/tmp/claxedo-agent-plugins-real-app/project-three"
    const projects = [{
      id: projectId,
      worktree,
      workspaces: {
        [worktree]: { id: projectId, directory: worktree },
      },
    }]

    expect(localWorkspaceInProjects(projects, projectId)).toBe(true)
    expect(localWorkspaceInProjects(projects, worktree)).toBe(true)
  })
})
