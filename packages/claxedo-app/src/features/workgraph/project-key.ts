export function appProjectWorkGraphKey(
  project: Readonly<{
    worktree: string
    git?: { remote?: string | null }
    workspaces?: Record<
      string,
      {
        id?: string
        workspaceId?: string
        directory?: string
        remote_directory?: string
        kind?: string
        git_remote?: string
        repo_url?: string
      }
    >
  }>,
  directory = project.worktree,
) {
  const workspace = Object.entries(project.workspaces ?? {}).find(([key, candidate]) =>
    [key, candidate.id, candidate.workspaceId, candidate.directory, candidate.remote_directory].includes(directory),
  )?.[1]
  const hosted = new Set(["cloud", "user-hosted"]).has(workspace?.kind ?? "")
  const repositoryUrl = workspace?.git_remote ?? workspace?.repo_url ?? project.git?.remote
  if (hosted && repositoryUrl) return `hosted:${repositoryUrl}`
  return `local:${project.worktree}`
}
