import { batch, createContext, createEffect, createMemo, createSignal, on, useContext, type Accessor, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useServer, type EngineProject, type Server } from "@/server"
import {
  planProjectColorAssignment,
  projectCatalog,
  resolveSandboxRootActions,
  shouldStoreOpenedProject,
  sidebarProjectsMissingFromApi,
} from "./project-catalog"
import { createProjectState, validProjectRef, type ProjectState } from "./project-state"

export const AVATAR_COLOR_KEYS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const

export type LocalProject = Omit<Partial<EngineProject>, "worktree" | "icon"> & {
  worktree: string
  expanded: boolean
  icon?: { url?: string; override?: string; color?: string }
}

function pickAvailableColor(used: Set<string>): string {
  const available = AVATAR_COLOR_KEYS.filter((c) => !used.has(c))
  if (available.length === 0) return AVATAR_COLOR_KEYS[Math.floor(Math.random() * AVATAR_COLOR_KEYS.length)] ?? "pink"
  return available[Math.floor(Math.random() * available.length)] ?? "pink"
}

function enrich(project: { worktree: string; expanded: boolean }, meta: EngineProject | undefined): LocalProject {
  return { ...meta, ...project, icon: { url: meta?.icon?.url, override: meta?.icon?.override, color: meta?.icon?.color } }
}

function createIntent() {
  const [createRequests, setCreateRequests] = createSignal(0)
  const [createAnswered, setCreateAnswered] = createSignal(0)
  const [createSurfaces, setCreateSurfaces] = createSignal(0)
  return {
    createRequests,
    requestCreate: () => setCreateRequests((count) => count + 1),
    createPending: () => createRequests() > createAnswered(),
    answerCreate: () => setCreateAnswered(createRequests()),
    hasCreateSurface: () => createSurfaces() > 0,
    registerCreateSurface: () => {
      setCreateSurfaces((count) => count + 1)
      return () => setCreateSurfaces((count) => count - 1)
    },
  }
}

function watchSandboxRoots(state: ProjectState, rootFor: (directory: string) => string) {
  createEffect(() => {
    const actions = resolveSandboxRootActions({ projects: state.list(), rootFor, valid: validProjectRef })
    batch(() => {
      for (const worktree of actions.removals) state.remove(worktree)
      for (const root of actions.opens) state.open(root)
      for (const root of actions.expands) state.expand(root)
    })
  })
}

function watchMissing(server: Server, state: ProjectState, api: Accessor<readonly EngineProject[]>) {
  createEffect(
    on(api, (projects) => {
      if (!server.capabilities()?.thisMachine || projects.length === 0) return
      const removals = sidebarProjectsMissingFromApi({ sidebar: state.list(), api: projects })
      batch(() => {
        for (const worktree of removals) state.remove(worktree)
      })
    }),
  )
}

function watchColors(server: Server, state: ProjectState, projects: Accessor<readonly LocalProject[]>) {
  const colorRequested = new Map<string, string>()
  createEffect(() => {
    const list = projects()
    if (list.length === 0) return
    const plan = planProjectColorAssignment({ projects: list, colors: { ...state.colors() }, colorRequested, pick: pickAvailableColor, isSigned: () => false })
    for (const { worktree, color } of plan.assignments) state.setColor(worktree, color)
    for (const { worktree, id, color } of plan.remoteUpdates) {
      void server.engineProjects.update({ id, worktree, icon: { color } }).catch((error: unknown) => {
        console.error("The project colour could not be saved", { worktree, color, error })
        if (colorRequested.get(worktree) === color) colorRequested.delete(worktree)
      })
    }
  })
}

function projectActions(state: ProjectState, rootFor: (directory: string) => string) {
  return {
    open: (directory: string) => {
      const root = rootFor(directory)
      if (!validProjectRef(root)) return
      if (!shouldStoreOpenedProject({ root, sidebar: state.list(), valid: validProjectRef })) return
      state.open(root)
    },
    close: state.close,
    isClosed: state.isClosed,
    remove: state.remove,
    expand: state.expand,
    collapse: state.collapse,
    toggle: (directory: string) => {
      const project = state.list().find((item) => item.worktree === directory)
      if (!project) return
      if (project.expanded) state.collapse(directory)
      else state.expand(directory)
    },
    move: state.move,
  }
}

export function createProjectList(server: Server) {
  const state = createProjectState("sidebar")
  const query = useQuery(() => server.queries.engineProjects.list())
  const api = createMemo(() => query.data ?? [])
  const catalog = createMemo(() => projectCatalog({ api: api(), current: state.list(), closed: state.isClosed, valid: validProjectRef }))
  const rootFor = (directory: string) => catalog().rootFor(directory)
  const enriched = createMemo(() => catalog().list.filter((project) => !!project?.worktree).map((project) => enrich(project, catalog().meta.get(project.worktree))))
  const list = createMemo(() =>
    enriched().map((project) => {
      const color = project.icon?.color ?? state.colors()[project.worktree]
      return color ? { ...project, icon: { ...project.icon, color } } : project
    }),
  )
  watchSandboxRoots(state, rootFor)
  watchMissing(server, state, api)
  watchColors(server, state, enriched)
  return { list, ready: () => query.data !== undefined, rootFor, ...createIntent(), ...projectActions(state, rootFor) }
}

export type ProjectList = ReturnType<typeof createProjectList>

const ProjectListContext = createContext<ProjectList>()

export function ProjectListProvider(props: { readonly children: JSX.Element }): JSX.Element {
  const list = createProjectList(useServer())
  return <ProjectListContext.Provider value={list}>{props.children}</ProjectListContext.Provider>
}

export function useProjectList(): ProjectList {
  const list = useContext(ProjectListContext)
  if (!list) throw new Error("useProjectList needs a ProjectListProvider above it")
  return list
}
