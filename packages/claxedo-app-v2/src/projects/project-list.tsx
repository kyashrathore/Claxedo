import { createContext, createEffect, createMemo, createSignal, on, useContext, type Accessor, type JSX } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useServer, type Project, type ProjectId, type Server } from "@/server"
import { pickAvailableColor, planProjectColorAssignment } from "./project-colors"
import { inCatalogOrder } from "./project-order"
import { createProjectState, type ProjectState } from "./project-state"

export type RailProject = { readonly project: Project; readonly expanded: boolean }

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

function watchColors(server: Server, state: ProjectState, projects: Accessor<readonly Project[]>) {
  const requested = new Map<string, string>()
  createEffect(() => {
    const list = projects()
    if (list.length === 0) return
    const plan = planProjectColorAssignment({ projects: list, colors: { ...state.colors() }, requested, pick: pickAvailableColor })
    for (const { id, color } of plan.assignments) state.setColor(id, color)
    for (const { id, color } of plan.remoteUpdates) {
      void server.projects.update(id, { icon: { color } }).catch((error: unknown) => {
        console.error("The project colour could not be saved", { projectId: id, color, error })
        if (requested.get(id) === color) requested.delete(id)
      })
    }
  })
}

export function createProjectList(server: Server) {
  const state = createProjectState("sidebar")
  const query = useQuery(() => server.queries.projects.list())
  const projects = createMemo(() => query.data ?? [])
  createEffect(
    on(projects, (list) => {
      if (query.data === undefined) return
      state.sync(inCatalogOrder(list).map((project) => project.id))
    }),
  )
  watchColors(server, state, projects)
  const list = createMemo((): readonly RailProject[] => {
    const byId = new Map<string, Project>(projects().map((project) => [project.id, project]))
    return state.order().flatMap((row) => {
      const project = byId.get(row.id)
      if (!project) return []
      const color = project.icon?.color ?? state.colors()[project.id]
      return [{ project: color ? { ...project, icon: { ...project.icon, color } } : project, expanded: row.expanded }]
    })
  })
  const toggle = (id: ProjectId) => {
    const row = state.order().find((item) => item.id === id)
    if (!row) return
    if (row.expanded) state.collapse(id)
    else state.expand(id)
  }
  return {
    list,
    ready: () => query.data !== undefined,
    expand: state.expand,
    collapse: state.collapse,
    toggle,
    move: state.move,
    ...createIntent(),
  }
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
