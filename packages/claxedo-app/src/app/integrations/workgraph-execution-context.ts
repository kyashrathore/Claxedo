import type { ExecutionEnvironment } from "@claxedo/workgraph/contracts"
import { isRelayBackedWorkspaceKind, workspaceKind } from "@/platform/runtime/agent/workspace-kind"

export type ProjectExecutionContext = {
  worktree: string
  sandboxes?: string[]
  git?: { remote?: string | null }
  workspaces?: Record<string, {
    id?: string
    workspaceId?: string
    directory?: string
    remote_directory?: string
    kind?: string
    git_remote?: string
    repo_url?: string
  }>
}

export function workGraphExecutionContext(
  current: string,
  projects: ProjectExecutionContext[],
): ExecutionEnvironment | undefined {
  const project = projects.find((candidate) =>
    candidate.worktree === current ||
    candidate.sandboxes?.includes(current) ||
    Object.entries(candidate.workspaces ?? {}).some(([key, workspace]) =>
      [key, workspace.id, workspace.workspaceId, workspace.directory, workspace.remote_directory].includes(current),
    ),
  )
  const workspace = Object.entries(project?.workspaces ?? {}).find(([key, candidate]) =>
    [key, candidate.id, candidate.workspaceId, candidate.directory, candidate.remote_directory].includes(current),
  )?.[1]
  const hosted = isRelayBackedWorkspaceKind(workspaceKind(workspace?.kind)) || current.startsWith("workspace:")
  const repositoryUrl = workspace?.git_remote ?? workspace?.repo_url ?? project?.git?.remote ?? undefined
  if (hosted) return repositoryUrl ? { kind: "hosted_workspace", placement: "shared", repositoryUrl } : undefined
  return current.startsWith("/") ? { kind: "local_worktree", placement: "shared", directory: current } : undefined
}
