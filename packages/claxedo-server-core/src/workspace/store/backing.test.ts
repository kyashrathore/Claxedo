import { describe, expect, test } from "vitest"
import { workspaceBacking } from "./backing"
import { controlPlaneListRow } from "./response"
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

  test("a cloud row stored before the driver was required stays a cloud-vm", () => {
    expect(workspaceBacking(ws({
      kind: "cloud",
      workspace_name: "selfhost",
      project_name: "acme",
      git_branch: "main",
    }))).toEqual({
      kind: "cloud-vm",
      workspaceName: "selfhost",
      projectName: "acme",
      branch: "main",
    })
  })

  test("a cloud backing publishes the remote directory, never the sandbox's own path field", () => {
    const cloud = workspaceBacking(ws({
      kind: "cloud",
      directory: "/workspace/cloud",
      driver: "daytona",
      sandbox_id: "sandbox-x",
    }))
    expect(cloud).not.toHaveProperty("directory")
    expect(cloud).not.toHaveProperty("remoteDirectory")
  })
})

/**
 * The list row and the resolve projection are different contracts over the same
 * row. A reader narrows a list row by comparing `backing` to a bare word, so the
 * resolve projection's object `backing` reaching a list caller parses as "states
 * no placement" and costs that caller its whole list, not one row.
 */
describe("controlPlaneListRow", () => {
  test("states the backing as the bare word the authority stores", () => {
    expect(controlPlaneListRow(ws({ kind: "cloud", driver: "modal", remote_directory: "/workspace" })))
      .toEqual({ workspace_id: "ws-1", project_id: "ws-1", backing: "cloud-vm", remote_directory: "/workspace" })
    expect(controlPlaneListRow(ws({ workspace_name: "app" })))
      .toEqual({ workspace_id: "ws-1", project_id: "ws-1", backing: "local-worktree", display_name: "app", remote_directory: "/tmp/repo" })
  })

  test("never carries the resolve projection's object backing or its git block", () => {
    const row: Record<string, unknown> = controlPlaneListRow(ws({ kind: "cloud", driver: "modal", git_branch: "dev" }))

    expect(typeof row.backing).toBe("string")
    expect(row).not.toHaveProperty("git")
    expect(row).not.toHaveProperty("access")
    expect(row).not.toHaveProperty("kind")
  })

  test("a cloud row with no remote directory falls back to the stored one", () => {
    expect(controlPlaneListRow(ws({ kind: "cloud", driver: "modal", directory: "/fallback" })))
      .toMatchObject({ remote_directory: "/fallback" })
  })
})
