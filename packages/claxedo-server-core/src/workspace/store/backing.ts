import type { SandboxDriverID } from "@claxedo/sandbox-contract"
import type { Workspace } from "./index"

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

/**
 * Derives the public backing model from the persisted workspace record.
 *
 * Each optional field is spread in only when present. An explicit
 * `undefined`-valued key is not the same as an absent one once the record is
 * serialized, and these values reach clients as JSON.
 */
export function workspaceBacking(workspace: Workspace): WorkspaceBacking {
  const shared = {
    ...(workspace.repo_url !== undefined ? { repoUrl: workspace.repo_url } : {}),
    ...(workspace.repo_name !== undefined ? { repoName: workspace.repo_name } : {}),
    ...(workspace.git_branch !== undefined ? { branch: workspace.git_branch } : {}),
  }
  const named = {
    ...(workspace.workspace_name !== undefined ? { workspaceName: workspace.workspace_name } : {}),
    ...(workspace.project_name !== undefined ? { projectName: workspace.project_name } : {}),
  }
  if (workspace.kind === "cloud") {
    if (!workspace.driver) {
      return {
        kind: "user-hosted",
        ...named,
        ...(workspace.git_branch !== undefined ? { branch: workspace.git_branch } : {}),
      }
    }
    return {
      kind: "cloud-vm",
      driver: workspace.driver,
      ...named,
      ...shared,
      ...(workspace.remote_directory !== undefined ? { remoteDirectory: workspace.remote_directory } : {}),
    }
  }
  return { kind: "local-worktree", directory: workspace.directory, ...shared }
}
