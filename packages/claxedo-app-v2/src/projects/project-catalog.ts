import type { EngineProject as Project } from "@/server"

function isRejectedWorktree(dir: string) {
  if (dir === "/workspace") return true
  return false
}

export type ProjectState = {
  worktree: string
  expanded: boolean
}

export type DirectoryFn<R> = (directory: string) => R
export type DirectoryPredicate = DirectoryFn<boolean>

export function sandboxRoots(projects: readonly Project[] | undefined) {
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

type CatalogInput = {
  api: readonly Project[] | undefined
  current: readonly ProjectState[] | undefined
  closed: DirectoryPredicate
  valid: DirectoryPredicate
}

function catalogMeta(input: CatalogInput) {
  const meta = new Map<string, Project>()
  for (const project of input.api ?? []) {
    if (!input.valid(project.worktree)) continue
    if (isRejectedWorktree(project.worktree)) continue
    meta.set(project.worktree, project)
  }
  return meta
}

function catalogState(input: CatalogInput, rootFor: DirectoryFn<string>) {
  const state = new Map<string, ProjectState>()
  for (const project of input.current ?? []) {
    const root = rootFor(project.worktree)
    if (!input.valid(root) || state.has(root)) continue
    state.set(root, {
      worktree: root,
      expanded: project.expanded,
    })
  }
  return state
}

function catalogList(input: CatalogInput, rootFor: DirectoryFn<string>, meta: Map<string, Project>, state: Map<string, ProjectState>) {
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
  return list
}

export function projectCatalog(input: CatalogInput) {
  const roots = sandboxRoots(input.api)
  const rootFor = (directory: string) => resolveRoot(roots, directory)
  const meta = catalogMeta(input)
  const state = catalogState(input, rootFor)
  const list = catalogList(input, rootFor, meta, state)
  return {
    meta,
    state,
    list,
    rootFor,
  }
}

export function shouldStoreOpenedProject(input: {
  root: string
  sidebar: readonly { worktree: string }[]
  valid: DirectoryPredicate
}) {
  if (!input.valid(input.root)) return false
  return !input.sidebar.some((project) => project.worktree === input.root)
}

export function resolveSandboxRootActions(input: {
  projects: readonly ProjectState[]
  rootFor: (directory: string) => string
  valid: (directory: string) => boolean
}): { removals: string[]; opens: string[]; expands: string[] } {
  const removals: string[] = []
  const opens: string[] = []
  const expands: string[] = []
  const seen = new Set(input.projects.map((p) => p.worktree))

  for (const project of input.projects) {
    const root = input.rootFor(project.worktree)
    if (root === project.worktree) continue
    removals.push(project.worktree)
    if (!seen.has(root) && input.valid(root)) {
      opens.push(root)
      seen.add(root)
    }
    if (project.expanded) expands.push(root)
  }

  return { removals, opens, expands }
}

export function sidebarProjectsMissingFromApi(input: {
  sidebar: readonly ProjectState[]
  api: readonly Project[]
}): string[] {
  const apiWorktrees = new Set(input.api.map((p) => p.worktree))
  return input.sidebar.filter((project) => !apiWorktrees.has(project.worktree)).map((project) => project.worktree)
}

export function syncApiProjectsToSidebar(input: {
  api: readonly Project[]
  sidebar: string[]
  isClosed: (directory: string) => boolean
  valid: (directory: string) => boolean
}): string[] | undefined {
  const sandboxDirs = new Set<string>()
  for (const project of input.api) {
    for (const sandbox of project.sandboxes ?? []) {
      if (sandbox !== project.worktree) sandboxDirs.add(sandbox)
    }
  }

  const api = input.api.map((p) => p.worktree).filter((w) => input.valid(w) && !sandboxDirs.has(w))
  if (api.length === 0) return undefined

  const current = input.sidebar.filter(input.valid)
  const apiSet = new Set(api)
  const keep = current.filter((worktree) => apiSet.has(worktree))
  const keepSet = new Set(keep)
  const next = [...keep, ...api.filter((worktree) => !keepSet.has(worktree) && !input.isClosed(worktree))]

  const changed = next.length !== current.length || next.some((x, i) => x !== current[i])
  if (!changed) return undefined
  return next
}

export type ColorableProject = {
  worktree: string
  id?: string
  icon?: { color?: string }
}

export type ProjectColorPlan<C extends string = string> = {
    clears: string[]
    assignments: Array<{ worktree: string; color: C }>
    metaUpserts: Array<{ worktree: string; color: C }>
    remoteUpdates: Array<{ worktree: string; id: string; color: C }>
}

type ColorPlanInput<C extends string> = {
  projects: readonly ColorableProject[]
  colors: Record<string, C>
  colorRequested: Map<string, C>
  pick: (used: Set<string>) => C
  isSigned: (worktree: string) => boolean
}

function usedColors<C extends string>(input: ColorPlanInput<C>, plan: ProjectColorPlan<C>) {
  for (const project of input.projects) {
    if (project.icon?.color) {
      input.colorRequested.delete(project.worktree)
      plan.clears.push(project.worktree)
    }
  }

  const used = new Set<string>()
  for (const project of input.projects) {
    const color = project.icon?.color ?? input.colors[project.worktree]
    if (color) used.add(color)
  }
  return used
}

export function planProjectColorAssignment<C extends string = string>(input: ColorPlanInput<C>): ProjectColorPlan<C> {
  const plan: ProjectColorPlan<C> = { clears: [], assignments: [], metaUpserts: [], remoteUpdates: [] }
  const used = usedColors(input, plan)

  for (const project of input.projects) {
    if (project.icon?.color) continue
    const worktree = project.worktree
    const existing = input.colors[worktree]
    const color = existing ?? input.pick(used)
    if (!existing) {
      used.add(color)
      plan.assignments.push({ worktree, color })
    }
    if (!project.id) continue

    const requested = input.colorRequested.get(worktree)
    if (requested === color) continue
    input.colorRequested.set(worktree, color)

    if (project.id === "global" || input.isSigned(worktree)) {
      plan.metaUpserts.push({ worktree, color })
      continue
    }
    plan.remoteUpdates.push({ worktree, id: project.id, color })
  }

  return plan
}

export function canAutoOpenProject(input: {
  api: readonly Project[] | undefined
  list: ReadonlyArray<{ worktree: string; sandboxes?: readonly string[] }> | undefined
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
