import type { Project } from "@opencode-ai/sdk/v2"

function isRejectedWorktree(dir: string) {
  if (dir === "/workspace") return true
  return false
}

export type ProjectState = {
  worktree: string
  expanded: boolean
}

export function sandboxRoots(projects: Project[] | undefined) {
  const map = new Map<string, string>()
  for (const project of projects ?? []) {
    for (const sandbox of project.sandboxes ?? []) {
      map.set(sandbox, project.worktree)
    }
  }
  return map
}

export function resolveRoot(roots: Map<string, string>, directory: string) {
  if (roots.size === 0) return directory
  const seen = new Set<string>()
  const chain = [directory]

  while (chain.length) {
    const current = chain[chain.length - 1]
    if (!current) return directory
    const next = roots.get(current)
    if (!next) return current
    if (seen.has(next)) return directory
    seen.add(next)
    chain.push(next)
  }

  return directory
}

export function projectCatalog(input: {
  api: Project[] | undefined
  current: ProjectState[] | undefined
  closed: (directory: string) => boolean
  valid: (directory: string) => boolean
}) {
  const roots = sandboxRoots(input.api)
  const rootFor = (directory: string) => resolveRoot(roots, directory)
  const meta = new Map<string, Project>()

  for (const project of input.api ?? []) {
    if (!input.valid(project.worktree)) continue
    if (isRejectedWorktree(project.worktree)) continue
    meta.set(project.worktree, project)
  }

  const state = new Map<string, ProjectState>()
  for (const project of input.current ?? []) {
    const root = rootFor(project.worktree)
    if (!input.valid(root) || state.has(root)) continue
    state.set(root, {
      worktree: root,
      expanded: project.expanded,
    })
  }

  const list: ProjectState[] = []
  const seen = new Set<string>()

  for (const project of input.current ?? []) {
    const root = rootFor(project.worktree)
    if (!input.valid(root) || seen.has(root) || !meta.has(root) || input.closed(root)) continue
    seen.add(root)
    list.push(state.get(root) ?? { worktree: root, expanded: project.expanded })
  }

  for (const [root] of meta) {
    if (seen.has(root) || input.closed(root)) continue
    seen.add(root)
    list.push(state.get(root) ?? { worktree: root, expanded: true })
  }

  return {
    meta,
    state,
    list,
    rootFor,
  }
}

export function canAutoOpenProject(input: {
  api: Project[] | undefined
  list: Array<{ worktree: string; sandboxes?: string[] }> | undefined
  dir?: string
  closed: (directory: string) => boolean
  ignoreClosed?: boolean
}) {
  const dir = input.dir
  if (!dir) return false
  if ((input.list ?? []).some((project) => project.worktree === dir || project.sandboxes?.includes(dir))) {
    return false
  }
  const root = resolveRoot(sandboxRoots(input.api), dir)
  if (input.ignoreClosed) return true
  return !input.closed(root)
}
