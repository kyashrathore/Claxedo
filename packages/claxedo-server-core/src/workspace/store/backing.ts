import type { SandboxProvisionerID } from "@claxedo/sandbox-contract"
import type { Workspace } from "./index"
import { workspacePlacement } from "./placement"

export type LocalWorktreeBacking = {
  kind: "local-worktree"
  directory: string
  repoUrl?: string
  repoName?: string
  branch?: string
}

export type CloudVmBacking = {
  kind: "cloud-vm"
  driver?: SandboxProvisionerID
  projectName?: string
  workspaceName?: string
  repoUrl?: string
  repoName?: string
  branch?: string
  remoteDirectory?: string
}

export type WorkspaceBacking = LocalWorktreeBacking | CloudVmBacking

/**
 * The placement as clients read it.
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
  const host = workspacePlacement(workspace).host
  if (host.kind === "self") return { kind: "local-worktree", directory: workspace.directory, ...shared }
  return {
    kind: "cloud-vm",
    ...(host.driver ? { driver: host.driver } : {}),
    ...(workspace.workspace_name !== undefined ? { workspaceName: workspace.workspace_name } : {}),
    ...(workspace.project_name !== undefined ? { projectName: workspace.project_name } : {}),
    ...shared,
    ...(workspace.remote_directory !== undefined ? { remoteDirectory: workspace.remote_directory } : {}),
  }
}
