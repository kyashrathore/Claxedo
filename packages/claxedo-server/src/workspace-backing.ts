import type { Workspace } from "./workspace-store"
import type { SandboxDriverID } from "@claxedo/sandbox-manager/driver-catalog"

/**
 * Normalized workspace backing model aligned with the target API. The
 * `kind` field replaces ad-hoc client checks against the persisted
 * `Workspace.kind` enum, which only distinguishes local vs cloud and
 * cannot represent user-hosted runtimes.
 *
 * The internal store keeps its existing `Workspace.kind: "local" |
 * "cloud"` field for backwards compatibility. This module derives the
 * normalized record without changing storage.
 */

export type LocalWorktreeBacking = {
  kind: "local-worktree"
  directory: string
  repoUrl?: string
  repoName?: string
  branch?: string
}

export type CloudVmBacking = {
  kind: "cloud-vm"
  driver: SandboxDriverID
  projectName?: string
  workspaceName?: string
  repoUrl?: string
  repoName?: string
  branch?: string
  remoteDirectory?: string
}

export type UserHostedBacking = {
  kind: "user-hosted"
  workspaceName?: string
  projectName?: string
  branch?: string
}

export type WorkspaceBacking = LocalWorktreeBacking | CloudVmBacking | UserHostedBacking

function omitUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T
}

/**
 * Derive a normalized backing record from a persisted Workspace.
 *
 * Cloud workspaces with a driver are cloud-vm even before the sandbox
 * lease is attached. Cloud workspaces without a driver are user-hosted:
 * the workspace was created against the team control plane but is served
 * by a runtime the user runs themselves and reaches through the relay.
 * Anything else is local-worktree backed by `directory`.
 */
export function workspaceBacking(workspace: Workspace): WorkspaceBacking {
  if (workspace.kind === "cloud") {
    if (!workspace.driver) {
      return omitUndefined({
        kind: "user-hosted",
        workspaceName: workspace.workspace_name,
        projectName: workspace.project_name,
        branch: workspace.git_branch,
      })
    }
    return omitUndefined({
      kind: "cloud-vm",
      driver: workspace.driver,
      projectName: workspace.project_name,
      workspaceName: workspace.workspace_name,
      repoUrl: workspace.repo_url,
      repoName: workspace.repo_name,
      branch: workspace.git_branch,
      remoteDirectory: workspace.remote_directory,
    })
  }
  return omitUndefined({
    kind: "local-worktree",
    directory: workspace.directory,
    repoUrl: workspace.repo_url,
    repoName: workspace.repo_name,
    branch: workspace.git_branch,
  })
}
