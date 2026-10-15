import type { Workspace } from "../workspace/store/index"

/**
 * Which of a project's workspaces a task without a preference starts in.
 *
 * The project's own root workspace is the answer wherever there is one. Past
 * that the rows are worktrees and clones of one repository, and picking the
 * oldest or the first would silently run the task somewhere the user did not
 * choose — so an unresolved choice is handed back to them by name.
 */
export function chooseProjectWorkspace(
  projectId: string,
  workspaces: readonly Workspace[],
): { workspace: Workspace } | { detail: string } {
  const candidates = workspaces.filter((workspace) => (workspace.project_id ?? workspace.id) === projectId)
  const only = candidates.length === 1 ? candidates.at(0) : undefined
  if (only) return { workspace: only }
  if (candidates.length === 0) {
    return { detail: `Project ${projectId} has no workspace this host can start a session in` }
  }
  const root = candidates.find((workspace) => workspace.id === projectId)
  if (root) return { workspace: root }
  const checkouts = candidates.filter((workspace) => !workspace.repo_root || workspace.repo_root === workspace.directory)
  const checkout = checkouts.length === 1 ? checkouts.at(0) : undefined
  if (checkout) return { workspace: checkout }
  const names = candidates.map((workspace) => workspace.workspace_name || workspace.directory).join(", ")
  return {
    detail: `Project ${projectId} has ${candidates.length} workspaces (${names}); name one on the task before starting`,
  }
}
