import type { ProjectSummary, SurfaceComponent } from "@claxedo/plugin-api"
import { isTaskCreateStatus, type TaskStatus, type TaskSummary } from "../../contracts"
import type { Translate } from "../dictionary"
import type { JsonObject } from "../surface/json"
import { bound, callout, surfaceButton, surfaceColumn } from "../surface/parts"
import { createComponents, createData, projectOptions } from "./create-view"
import { PAGE_EVENTS } from "./events"
import { COLLECTION_KEYS, COLLECTION_STATUSES, inCollection, STATUS_LOOKS, TASK_COLLECTIONS, taskKey } from "./model"
import { taskRow, taskRowComponents, type RowContext } from "./row-items"
import { activePresets, startWithPreset, type PageState } from "./state"
import { startProgressText } from "./start-run"

export type PageView = {
  readonly t: Translate
  readonly state: PageState
  readonly projects: readonly ProjectSummary[]
  readonly projectId: string | undefined
  readonly now: number
}

export function projectNameOf(view: PageView): string {
  return view.projects.find((project) => project.id === view.projectId)?.name ?? ""
}

export function visibleTasks(state: PageState): readonly TaskSummary[] {
  return state.list.kind === "ready" ? state.list.tasks.filter((task) => inCollection(task, state.collection)) : []
}

function pageHeader(view: PageView): SurfaceComponent[] {
  const { t } = view
  const views = [
    { label: t("claxedo-tasks.toolbar.list"), value: "list", icon: "viewList" as const },
    { label: t("claxedo-tasks.toolbar.board"), value: "board", icon: "viewBoard" as const },
  ]
  const project: SurfaceComponent[] = view.projects.length > 0
    ? [{ id: "tasks-project", component: "ChoicePicker", label: t("claxedo-tasks.toolbar.project"), variant: "mutuallyExclusive", displayStyle: "menu", options: projectOptions(view.projects), value: bound("/controls/project"), change: { event: { name: PAGE_EVENTS.project } } }]
    : []
  return [
    { id: "page-header", component: "Header", title: t("claxedo-tasks.page.title"), badges: project.map((part) => part.id), actions: ["tasks-view", "page-new"] },
    ...project,
    { id: "tasks-view", component: "ChoicePicker", label: t("claxedo-tasks.toolbar.view"), variant: "mutuallyExclusive", displayStyle: "chips", iconOnly: true, options: views, value: bound("/controls/view"), change: { event: { name: PAGE_EVENTS.view } } },
    ...surfaceButton("page-new", t("claxedo-tasks.page.newTask"), PAGE_EVENTS.openCreate, { variant: "primary", icon: "add" }),
  ]
}

function pageNotice(view: PageView): SurfaceComponent[] {
  const { t, state } = view
  const progress = startProgressText(t, state.progress)
  if (progress) return [{ id: "page-notice", component: "Spinner", label: t("claxedo-tasks.start.progressOf", { title: state.progressTitle ?? "", progress }) }]
  if (state.startRefusal) {
    return [callout("page-notice", "warning", t("claxedo-tasks.start.refusedTitle", { title: state.startRefusal.title }), { text: state.startRefusal.message, dismissible: true })]
  }
  if (state.listNotice) return [callout("page-notice", "warning", state.listNotice, { dismissible: true })]
  if (state.presets.kind === "ready" && activePresets(state).length === 0 && state.list.kind === "ready" && state.list.tasks.length > 0) {
    return [
      callout("page-notice", "info", t("claxedo-tasks.page.noPresetsTitle"), { text: t("claxedo-tasks.page.noPresetsText"), action: "page-notice-action", dismissible: true }),
      ...surfaceButton("page-notice-action", t("claxedo-tasks.page.createPreset"), PAGE_EVENTS.openPresets),
    ]
  }
  return []
}

function boardStatuses(state: PageState, tasks: readonly TaskSummary[]): readonly TaskStatus[] {
  const statuses = COLLECTION_STATUSES[state.collection]
  return state.view === "board" ? statuses : statuses.filter((status) => tasks.some((task) => task.status === status))
}

function board(view: PageView, tasks: readonly TaskSummary[]): SurfaceComponent[] {
  const { t, state } = view
  const statuses = boardStatuses(state, tasks)
  const adders = statuses.filter(isTaskCreateStatus)
  const columns = statuses.map((status) => ({
    key: status,
    title: t(STATUS_LOOKS[status].key),
    items: `/board/${status}`,
    ...(isTaskCreateStatus(status) ? { headerActions: [`board-add-${status}`] } : {}),
  }))
  return [
    { id: "tasks-content", component: "Board", columns, item: "task-row", itemKey: "id", movable: "movable", move: { event: { name: PAGE_EVENTS.moveTask } }, layout: state.view === "board" ? "columns" : "list" },
    ...adders.flatMap((status) => surfaceButton(`board-add-${status}`, t("claxedo-tasks.board.newIn", { status: t(STATUS_LOOKS[status].key) }), PAGE_EVENTS.boardCreate, { icon: "add", variant: "borderless", context: { status } })),
  ]
}

function taskListContent(view: PageView): SurfaceComponent[] {
  const { t, state } = view
  if (!view.projectId) return [{ id: "tasks-content", component: "EmptyState", title: t("claxedo-tasks.page.noProjectTitle"), description: t("claxedo-tasks.page.noProjectText") }]
  if (state.list.kind === "idle" || state.list.kind === "loading") return [{ id: "tasks-content", component: "Spinner", label: t("claxedo-tasks.page.loading") }]
  if (state.list.kind === "failed") {
    return [
      callout("tasks-content", "danger", t("claxedo-tasks.page.loadFailed"), { text: state.list.message, action: "tasks-retry" }),
      ...surfaceButton("tasks-retry", t("claxedo-tasks.page.retry"), PAGE_EVENTS.retryList, { icon: "refresh" }),
    ]
  }
  const tasks = visibleTasks(state)
  if (tasks.length === 0 && state.view !== "board") {
    return [{ id: "tasks-content", component: "EmptyState", title: t("claxedo-tasks.page.emptyTitle", { collection: t(COLLECTION_KEYS[state.collection]) }), description: t("claxedo-tasks.page.emptyText") }]
  }
  return board(view, tasks)
}

function more(view: PageView): SurfaceComponent[] {
  const { t, state } = view
  if (state.list.kind !== "ready" || !state.list.nextCursor) return []
  if (state.list.more === "loading") return [{ id: "tasks-more", component: "Spinner", label: t("claxedo-tasks.page.loadingMore") }]
  return surfaceButton("tasks-more", t(state.list.more === "failed" ? "claxedo-tasks.page.retry" : "claxedo-tasks.page.loadMore"), PAGE_EVENTS.loadMore, { variant: "borderless", icon: state.list.more === "failed" ? "refresh" : undefined })
}

export function listComponents(view: PageView): SurfaceComponent[] {
  const { t, state } = view
  const noticeParts = pageNotice(view)
  const moreParts = more(view)
  const tabs = TASK_COLLECTIONS.map((collection) => ({ title: t(COLLECTION_KEYS[collection]), child: "tasks-body" }))
  const create = state.create.kind === "open" ? createComponents(t, state.create, view) : []
  return [
    surfaceColumn("root", ["page-header", ...noticeParts.slice(0, 1).map((part) => part.id), "tasks-tabs", ...create.slice(0, 1).map((part) => part.id)]),
    ...pageHeader(view),
    ...noticeParts,
    { id: "tasks-tabs", component: "Tabs", tabs, selected: bound("/controls/collection"), change: { event: { name: PAGE_EVENTS.collection } } },
    surfaceColumn("tasks-body", ["tasks-content", ...moreParts.slice(0, 1).map((part) => part.id)]),
    ...taskListContent(view),
    ...taskRowComponents(t),
    ...moreParts,
    ...create,
  ]
}

function boardData(view: PageView, context: RowContext, tasks: readonly TaskSummary[]): JsonObject {
  const lists: JsonObject = {}
  for (const status of COLLECTION_STATUSES[view.state.collection]) lists[status] = tasks.filter((task) => task.status === status).map((task) => taskRow(context, task))
  return lists
}

export function rowContext(view: PageView): RowContext {
  const state = view.state
  const projectName = projectNameOf(view)
  const keys = new Map((state.list.kind === "ready" ? state.list.tasks : []).map((task) => [task.id, taskKey(projectName, task)]))
  return { t: view.t, projectName, now: view.now, startWith: startWithPreset(state), keyOf: (id) => keys.get(id) }
}

export function listData(view: PageView): JsonObject {
  const { state, t } = view
  const tasks = visibleTasks(state)
  return {
    controls: {
      collection: TASK_COLLECTIONS.indexOf(state.collection),
      project: view.projectId ? [view.projectId] : [],
      view: [state.view],
    },
    board: boardData(view, rowContext(view), tasks),
    ...(state.create.kind === "open" ? { create: createData(t, state.create, view) } : {}),
  }
}
