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

function omitUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T
}

/** Derives the public backing model from the persisted workspace record. */
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
