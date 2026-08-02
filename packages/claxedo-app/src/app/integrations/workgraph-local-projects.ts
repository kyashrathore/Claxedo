import { workGraphExecutionContext, type ProjectExecutionContext } from "./workgraph-execution-context"

type OpenProject = { worktree: string; name?: string }

/**
 * The local projects the New stream dialog can target.
 *
 * Sourced from the OPEN project list (what the rail renders), with the
 * control-plane catalog used only to classify a directory: a project the rail is
 * showing must be selectable even when the catalog has not been populated yet,
 * and a directory the catalog resolves to a hosted workspace is never offered as
 * a local worktree. Labels prefer the project's own name so the picker reads the
 * same as the rail.
 */
export function workGraphLocalProjectOptions(
  open: readonly OpenProject[],
  catalog: readonly ProjectExecutionContext[],
) {
  const seen = new Set<string>()
  const options: { value: string; label: string }[] = []
  for (const project of open) {
    const worktree = project.worktree?.trim()
    if (!worktree || seen.has(worktree)) continue
    const known = catalog.find((candidate) => candidate.worktree === worktree)
    const environment = workGraphExecutionContext(worktree, known ? [known] : [])
    if (environment?.kind !== "local_worktree") continue
    seen.add(worktree)
    options.push({ value: worktree, label: project.name?.trim() || worktree })
  }
  return options
}
