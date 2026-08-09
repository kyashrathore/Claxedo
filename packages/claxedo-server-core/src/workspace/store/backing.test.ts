import { describe, expect, test } from "vitest"
import { workspaceBacking } from "./backing"
import type { Workspace } from "./index"

function ws(input: Partial<Workspace>): Workspace {
  return {
    id: "ws-1",
    directory: "/tmp/repo",
    kind: "local",
    created_at: 0,
    updated_at: 0,
    ...input,
  }
}

describe("workspaceBacking", () => {
  test("returns local-worktree for a local workspace created from a directory", () => {
    expect(workspaceBacking(ws({
      directory: "/tmp/repo",
      repo_url: "git@github.com:acme/repo.git",
      repo_name: "repo",
      git_branch: "main",
    }))).toEqual({
      kind: "local-worktree",
      directory: "/tmp/repo",
      repoUrl: "git@github.com:acme/repo.git",
      repoName: "repo",
      branch: "main",
    })
  })

  test("omits unset metadata fields from local-worktree backings", () => {
    expect(workspaceBacking(ws({
      directory: "/tmp/scratch",
    }))).toEqual({
      kind: "local-worktree",
      directory: "/tmp/scratch",
    })
  })

  test("returns cloud-vm with driver metadata for cloud workspaces", () => {
    expect(workspaceBacking(ws({
      kind: "cloud",
      driver: "daytona",
      project_name: "acme",
      workspace_name: "feature-x",
      repo_url: "https://github.com/acme/repo",
      repo_name: "repo",
      git_branch: "feature-x",
      sandbox_id: "sandbox-123",
      remote_directory: "/workspace/repo",
    }))).toEqual({
      kind: "cloud-vm",
      driver: "daytona",
      projectName: "acme",
      workspaceName: "feature-x",
      repoUrl: "https://github.com/acme/repo",
      repoName: "repo",
      branch: "feature-x",
      remoteDirectory: "/workspace/repo",
    })
  })

  test("keeps driver-backed cloud workspaces as cloud-vm before sandbox attach", () => {
    expect(workspaceBacking(ws({
      kind: "cloud",
      driver: "daytona",
      project_name: "acme",
      workspace_name: "feature-x",
      repo_url: "https://github.com/acme/repo",
      git_branch: "feature-x",
    }))).toEqual({
      kind: "cloud-vm",
      driver: "daytona",
      projectName: "acme",
      workspaceName: "feature-x",
      repoUrl: "https://github.com/acme/repo",
      branch: "feature-x",
    })
  })

  test("keeps docker-backed dev workspaces in the cloud-vm backing path", () => {
    expect(workspaceBacking(ws({
      kind: "cloud",
      driver: "docker",
      project_name: "acme",
      workspace_name: "docker-dev",
      sandbox_id: "container-123",
      remote_directory: "/workspace",
    }))).toEqual({
      kind: "cloud-vm",
      driver: "docker",
      projectName: "acme",
      workspaceName: "docker-dev",
      remoteDirectory: "/workspace",
    })
  })

  test("returns user-hosted when a cloud workspace has no driver/sandbox attached", () => {
    expect(workspaceBacking(ws({
      kind: "cloud",
      workspace_name: "selfhost",
      project_name: "acme",
      git_branch: "main",
    }))).toEqual({
      kind: "user-hosted",
      workspaceName: "selfhost",
      projectName: "acme",
      branch: "main",
    })
  })

  test("does not leak local host directory through user-hosted/cloud backings", () => {
    const cloud = workspaceBacking(ws({
      kind: "cloud",
      directory: "/workspace/cloud",
      driver: "daytona",
      sandbox_id: "sandbox-x",
    }))
    const userHosted = workspaceBacking(ws({
      kind: "cloud",
      directory: "/workspace/cloud",
    }))
    expect(cloud).not.toHaveProperty("directory")
    expect(userHosted).not.toHaveProperty("directory")
  })
})
