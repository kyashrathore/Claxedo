import type { PageProps, SurfaceChannel, SurfaceProgram } from "@claxedo/plugin-api"
import { createSurfaceSync, type SurfaceFrame } from "../surface/sync"
import { createTaskCreation } from "./create-commands"
import { detailAction } from "./detail-actions"
import { detailComponents, detailData } from "./detail-view"
import { taskListAction } from "./list-actions"
import { listComponents, listData, type PageView } from "./list-view"
import { createDetailLoads, createListLoads } from "./loads"
import { projectIdOf, type PageDeps, type PageModel } from "./page-model"
import { createStartCommands } from "./start-commands"
import { emptyDetail, INITIAL_PAGE_STATE, routeOf, type PageState } from "./state"
import { createTaskCommands } from "./task-commands"

function pageFrame(view: PageView): SurfaceFrame {
  const detail = view.state.route.kind === "detail" ? view.state.detail : undefined
  if (detail) return { components: detailComponents(view, detail), data: { detail: detailData(view, detail) } }
  return { components: listComponents(view), data: listData(view) }
}

function createModel(deps: PageDeps, channel: SurfaceChannel) {
  const sync = createSurfaceSync(channel)
  let state: PageState = INITIAL_PAGE_STATE
  let open = true
  const projectId = () => projectIdOf(deps, state)
  const draw = () => {
    if (open) sync.draw(pageFrame({ t: deps.t, state, projects: deps.projects(), projectId: projectId(), now: deps.now() }))
  }
  const model: PageModel = {
    deps,
    sync,
    state: () => state,
    patch: (change) => {
      state = { ...state, ...(typeof change === "function" ? change(state) : change) }
      draw()
    },
    projectId,
  }
  return { model, close: () => void (open = false) }
}

type RouteLoads = {
  readonly list: (quiet?: boolean) => Promise<void>
  readonly detail: (taskId: string) => Promise<void>
  readonly presets: () => Promise<void>
}

function routeTo(model: PageModel, loads: RouteLoads, params: Readonly<Record<string, string>>) {
  const route = routeOf(params)
  void loads.presets()
  const current = model.state().detail
  if (route.kind === "detail") {
    const fresh = current?.taskId === route.taskId ? current : emptyDetail(route.taskId)
    model.patch({ route, detail: fresh, startRefusal: undefined })
    void loads.detail(route.taskId)
    return
  }
  model.patch({ route, startRefusal: undefined })
  void loads.list(true)
}

export function openTasksPage(deps: PageDeps, channel: SurfaceChannel, props: PageProps): SurfaceProgram {
  const { model, close } = createModel(deps, channel)
  const lists = createListLoads(model)
  const loadDetail = createDetailLoads(model)
  const reloads = { list: lists.reload, detail: loadDetail }
  const commands = createTaskCommands(model, reloads)
  const starts = createStartCommands(model, reloads)
  let formKey = 0
  let imageKey = 0
  const create = createTaskCreation(model, (taskId) => {
    void lists.reload(true)
    deps.openPage({ taskId })
  })
  const listHandlers = { model, commands, starts, create, reload: () => lists.reload(), more: lists.more, nextKey: () => `image-${(imageKey += 1)}`, nextForm: () => (formKey += 1) }
  const detailHandlers = { model, commands, starts, loadDetail }
  let lastProjectId = model.projectId()
  deps.watchProjects(() => {
    const projectId = model.projectId()
    model.patch({})
    if (projectId !== lastProjectId) void lists.reload()
    lastProjectId = projectId
  })
  const routeLoads = { ...reloads, presets: lists.presets }
  routeTo(model, routeLoads, props.params)
  if (model.state().route.kind === "detail") void lists.reload()
  return {
    action: (action) => {
      if (model.state().route.kind === "detail" && detailAction(detailHandlers, action)) return
      taskListAction(listHandlers, action)
    },
    navigated: (next) => routeTo(model, routeLoads, next.params),
    dispose: close,
  }
}
