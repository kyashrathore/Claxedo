import { createSignal, type Accessor } from "solid-js"
import type { useServer } from "@/app/connection/server"
import type { Project } from "@opencode-ai/sdk/v2"

function isRejectedWorktree(dir: string) {
  if (dir === "/workspace") return true
  return false
}

export type ProjectState = {
  worktree: string
  expanded: boolean
}

/** A predicate over a workspace directory (validity, closed-ness, …). */
export type DirectoryFn<R> = (directory: string) => R
export type DirectoryPredicate = DirectoryFn<boolean>

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
  closed: DirectoryPredicate
  valid: DirectoryPredicate
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

/**
 * Whether opening `root` should write a new entry into the persisted sidebar
 * store.
 *
 * Deliberately NOT gated on the API catalog. The catalog is populated
 * asynchronously — and is empty until the directory is registered with the
 * server — so requiring a catalog hit here discarded the user's open-project
 * intent, losing the project on the next launch. What RENDERS is still gated on
 * the catalog by `projectCatalog`, so an unconfirmed entry stays stored and
 * unlisted instead of becoming a phantom row.
 */
export function shouldStoreOpenedProject(input: {
  root: string
  sidebar: readonly { worktree: string }[]
  isLocal: boolean
  valid: DirectoryPredicate
}) {
  if (!input.valid(input.root)) return false
  if (!input.isLocal) return false
  return !input.sidebar.some((project) => project.worktree === input.root)
}

/**
 * Effect 1 (sandbox → parent resolution): given the current sidebar projects,
 * decide which entries are sandboxes that must collapse into their root
 * project. Returns the imperative server.projects operations to apply, in the
 * per-project order the live effect applies them, so a sandbox worktree is
 * always removed and its root opened/expanded exactly once.
 */
export function resolveSandboxRootActions(input: {
  projects: ProjectState[]
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

/**
 * Effect 2: sidebar projects whose worktree is no longer present in the API
 * catalog and should be removed. Callers gate this on a non-empty API list so
 * a transient empty response never wipes the sidebar.
 */
export function sidebarProjectsMissingFromApi(input: {
  sidebar: ProjectState[]
  api: Project[]
}): string[] {
  const apiWorktrees = new Set(input.api.map((p) => p.worktree))
  return input.sidebar.filter((project) => !apiWorktrees.has(project.worktree)).map((project) => project.worktree)
}

/**
 * Reconcile the sidebar project list toward the API catalog (non-local
 * servers): keep the sidebar entries the API still knows, then append any API
 * worktrees not yet shown and not explicitly closed. Sandbox directories are
 * never surfaced as their own project. Returns the next ordered worktree list,
 * or `undefined` when nothing changed (so callers can skip the store write).
 */
export function syncApiProjectsToSidebar(input: {
  api: Project[]
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
  /** colorRequested keys to drop because the project now carries its own color. */
  clears: string[]
  /** local color choices to persist via setColors. */
  assignments: Array<{ worktree: string; color: C }>
  /** global/signed workspaces whose color is written through project-meta. */
  metaUpserts: Array<{ worktree: string; color: C }>
  /** remote projects whose color must be pushed to the control plane. */
  remoteUpdates: Array<{ worktree: string; id: string; color: C }>
}

/**
 * Decide, for the current enriched project list, which worktrees still need a
 * locally-assigned avatar color and where that color must be propagated
 * (local store, project-meta for global/signed workspaces, or a remote control
 * plane update). Mutates `colorRequested` the same way the live effect does so
 * a color is pushed to the server at most once per value. `pick` selects an
 * unused color (injected so tests are deterministic).
 */
export function planProjectColorAssignment<C extends string = string>(input: {
  projects: ColorableProject[]
  colors: Record<string, C>
  colorRequested: Map<string, C>
  pick: (used: Set<string>) => C
  isSigned: (worktree: string) => boolean
}): ProjectColorPlan<C> {
  const plan: ProjectColorPlan<C> = { clears: [], assignments: [], metaUpserts: [], remoteUpdates: [] }

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

export type LayoutProjectsServer = Pick<ReturnType<typeof useServer>, "isLocal" | "projects">

/**
 * The layout's `projects` API: the sidebar list, the open/close/expand
 * operations the rail delegates to the server, and the "create a project"
 * intent. Creation itself lives in the composer's Project chip; the rail's
 * "New Project" and the empty canvas only raise `requestCreate`, and whichever
 * composer is mounted opens its chip's create panel on the next
 * `createRequests` value (a counter, so two requests in a row both register).
 */
export function createLayoutProjectsApi<List extends Accessor<unknown>>(deps: {
  list: List
  server: LayoutProjectsServer
  rootFor: DirectoryFn<string>
  validProjectRef: DirectoryPredicate
  ensureDirectorySessionCache: DirectoryFn<void>
  sidebarProjects: () => readonly { worktree: string; expanded?: boolean }[]
}) {
  const [createRequests, setCreateRequests] = createSignal(0)
  const { server } = deps
  return {
    list: deps.list,
    createRequests,
    requestCreate() {
      setCreateRequests((count) => count + 1)
    },
    open(directory: string) {
      const root = deps.rootFor(directory)
      if (!deps.validProjectRef(root)) return
      deps.ensureDirectorySessionCache(root)
      if (!shouldStoreOpenedProject({ root, sidebar: deps.sidebarProjects(), isLocal: server.isLocal(), valid: deps.validProjectRef })) return
      server.projects.open(root)
    },
    close(directory: string) {
      if (!server.isLocal()) return
      server.projects.close(directory)
    },
    isClosed(directory: string) {
      if (!server.isLocal()) return false
      return server.projects.isClosed(directory)
    },
    remove(directory: string) {
      server.projects.remove(directory)
    },
    expand(directory: string) {
      server.projects.expand(directory)
    },
    collapse(directory: string) {
      server.projects.collapse(directory)
    },
    toggle(directory: string) {
      const project = deps.sidebarProjects().find((item) => item.worktree === directory)
      if (!project) return
      if (project.expanded) server.projects.collapse(directory)
      else server.projects.expand(directory)
    },
    move(directory: string, toIndex: number) {
      server.projects.move(directory, toIndex)
    },
  }
}
