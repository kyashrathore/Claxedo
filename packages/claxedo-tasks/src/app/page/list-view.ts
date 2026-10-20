import type { ProjectSummary, SurfaceComponent } from "@claxedo/plugin-api"
import { isTaskCreateStatus, TASK_STATUSES, type TaskStatus, type TaskSummary } from "../../contracts"
import type { Translate } from "../dictionary"
import type { Json, JsonObject } from "../surface/json"
import { bound, callout, surfaceButton, surfaceColumn } from "../surface/parts"
import { createComponents, createData } from "./create-view"
import { PAGE_EVENTS } from "./events"
import { COLLECTION_KEYS, COLLECTION_STATUSES, inCollection, STATUS_LOOKS, TASK_COLLECTIONS } from "./model"
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

function taskCountText(t: Translate, count: number): string {
  return count === 1 ? t("claxedo-tasks.page.count.one") : t("claxedo-tasks.page.count.other", { count })
}

function pageHeader(view: PageView): SurfaceComponent[] {
  const { t, state } = view
  const name = projectNameOf(view) || t("claxedo-tasks.page.noProject")
  const actions = state.create.kind === "open" ? ["page-presets"] : ["page-presets", "page-new"]
  return [
    { id: "page-header", component: "Header", title: t("claxedo-tasks.page.title"), subtitle: t("claxedo-tasks.page.subtitle", { project: name, count: taskCountText(t, visibleTasks(state).length) }), actions },
    ...surfaceButton("page-presets", t("claxedo-tasks.page.presets"), PAGE_EVENTS.openPresets, { variant: "borderless", icon: "settings" }),
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
      callout("page-notice", "info", t("claxedo-tasks.page.noPresetsTitle"), { text: t("claxedo-tasks.page.noPresetsText"), action: "page-notice-action" }),
      ...surfaceButton("page-notice-action", t("claxedo-tasks.page.createPreset"), PAGE_EVENTS.openPresets),
    ]
  }
  return []
}

function controls(view: PageView): SurfaceComponent[] {
  const { t, state } = view
  const presets = activePresets(state)
  const startWith: SurfaceComponent[] = presets.length > 0 ? [{ id: "tasks-start-with", component: "ChoicePicker", label: t("claxedo-tasks.toolbar.startWith"), variant: "mutuallyExclusive", displayStyle: "dropdown", options: presets.map((preset) => ({ label: preset.name, value: preset.id })), value: bound("/controls/startWith"), change: { event: { name: PAGE_EVENTS.startWith } } }] : []
  const views = [{ label: t("claxedo-tasks.toolbar.list"), value: "list" }, { label: t("claxedo-tasks.toolbar.board"), value: "board" }]
  return [
    { id: "tasks-controls", component: "Grid", columns: 3, children: ["tasks-project", ...startWith.map((entry) => entry.id), "tasks-view"] },
    { id: "tasks-project", component: "Combobox", label: t("claxedo-tasks.toolbar.project"), value: bound("/controls/project"), options: bound("/controls/projects"), placeholder: t("claxedo-tasks.toolbar.projectSearch"), change: { event: { name: PAGE_EVENTS.project } } },
    ...startWith,
    { id: "tasks-view", component: "ChoicePicker", label: t("claxedo-tasks.toolbar.view"), variant: "mutuallyExclusive", displayStyle: "chips", options: views, value: bound("/controls/view"), change: { event: { name: PAGE_EVENTS.view } } },
  ]
}

function display(t: Translate): SurfaceComponent[] {
  const statuses = [{ label: t("claxedo-tasks.toolbar.anyStatus"), value: "any" }, ...TASK_STATUSES.map((status) => ({ label: t(STATUS_LOOKS[status].key), value: status }))]
  const dates = [{ label: t("claxedo-tasks.toolbar.updated"), value: "updated" }, { label: t("claxedo-tasks.toolbar.created"), value: "created" }]
  return [
    { id: "tasks-display", component: "Collapsible", title: t("claxedo-tasks.toolbar.display"), child: "tasks-display-grid" },
    { id: "tasks-display-grid", component: "Grid", columns: 2, children: ["tasks-status-filter", "tasks-date", "tasks-subtasks", "tasks-grouped"] },
    { id: "tasks-status-filter", component: "ChoicePicker", label: t("claxedo-tasks.toolbar.status"), variant: "mutuallyExclusive", displayStyle: "dropdown", options: statuses, value: bound("/controls/status"), change: { event: { name: PAGE_EVENTS.statusFilter } } },
    { id: "tasks-date", component: "ChoicePicker", label: t("claxedo-tasks.toolbar.date"), variant: "mutuallyExclusive", displayStyle: "chips", options: dates, value: bound("/controls/date"), change: { event: { name: PAGE_EVENTS.dateField } } },
    { id: "tasks-subtasks", component: "Switch", label: t("claxedo-tasks.toolbar.showSubtasks"), value: bound("/controls/showChildren"), change: { event: { name: PAGE_EVENTS.showChildren } } },
    { id: "tasks-grouped", component: "Switch", label: t("claxedo-tasks.toolbar.grouped"), value: bound("/controls/grouped"), change: { event: { name: PAGE_EVENTS.grouped } } },
  ]
}

function boardStatuses(state: PageState, tasks: readonly TaskSummary[]): readonly TaskStatus[] {
  const statuses = COLLECTION_STATUSES[state.collection]
  return state.view === "board" ? statuses : statuses.filter((status) => tasks.some((task) => task.status === status))
}

function board(view: PageView, tasks: readonly TaskSummary[]): SurfaceComponent[] {
  const { t, state } = view
  const statuses = boardStatuses(state, tasks)
  const adders = state.view === "board" ? statuses.filter(isTaskCreateStatus) : []
  const columns = statuses.map((status) => ({
    key: status,
    title: t(STATUS_LOOKS[status].key),
    items: `/board/${status}`,
    ...(state.view === "board" && isTaskCreateStatus(status) ? { headerActions: [`board-add-${status}`] } : {}),
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
  if (state.view === "list" && !state.grouped) return [{ id: "tasks-content", component: "List", children: { componentId: "task-row", path: "/rows" } }]
  return board(view, tasks)
}

function more(view: PageView): SurfaceComponent[] {
  const { t, state } = view
  if (state.list.kind !== "ready" || !state.list.nextCursor) return []
  if (state.list.more === "loading") return [{ id: "tasks-more", component: "Spinner", label: t("claxedo-tasks.page.loadingMore") }]
  return surfaceButton("tasks-more", t(state.list.more === "failed" ? "claxedo-tasks.page.retry" : "claxedo-tasks.page.loadMore"), PAGE_EVENTS.loadMore, { icon: state.list.more === "failed" ? "refresh" : undefined })
}

export function listComponents(view: PageView): SurfaceComponent[] {
  const { t, state } = view
  const noticeParts = pageNotice(view)
  const moreParts = more(view)
  const tabs = TASK_COLLECTIONS.map((collection) => ({ title: t(COLLECTION_KEYS[collection]), child: "tasks-body" }))
  const create = state.create.kind === "open" ? createComponents(t, state.create, view.projects) : []
  return [
    surfaceColumn("root", ["page-header", ...noticeParts.slice(0, 1).map((part) => part.id), ...create.slice(0, 1).map((part) => part.id), "tasks-tabs"]),
    ...pageHeader(view),
    ...noticeParts,
    ...create,
    { id: "tasks-tabs", component: "Tabs", tabs, selected: bound("/controls/collection"), change: { event: { name: PAGE_EVENTS.collection } } },
    surfaceColumn("tasks-body", ["tasks-controls", "tasks-display", "tasks-content", ...moreParts.slice(0, 1).map((part) => part.id)]),
    ...controls(view),
    ...display(t),
    ...taskListContent(view),
    ...taskRowComponents(t),
    ...moreParts,
  ]
}

function boardData(view: PageView, context: RowContext, tasks: readonly TaskSummary[]): JsonObject {
  const lists: JsonObject = {}
  for (const status of COLLECTION_STATUSES[view.state.collection]) lists[status] = tasks.filter((task) => task.status === status).map((task) => taskRow(context, task))
  return lists
}

export function listData(view: PageView): JsonObject {
  const { state, t } = view
  const tasks = visibleTasks(state)
  const titles = new Map((state.list.kind === "ready" ? state.list.tasks : []).map((task) => [task.id, task.title]))
  const context: RowContext = { t, projectName: projectNameOf(view), dateField: state.dateField, now: view.now, startWith: startWithPreset(state), showStatus: !state.grouped && state.view === "list", titleOf: (id) => titles.get(id) }
  const options: Json[] = view.projects.map((project) => ({ label: project.name, value: project.id }))
  return {
    controls: {
      collection: TASK_COLLECTIONS.indexOf(state.collection),
      project: view.projectId ?? "",
      projects: options,
      startWith: startWithPreset(state) ? [startWithPreset(state)?.id ?? ""] : [],
      view: [state.view],
      status: [state.statusFilter ?? "any"],
      date: [state.dateField],
      showChildren: state.showChildren,
      grouped: state.grouped,
    },
    rows: tasks.map((task) => taskRow(context, task)),
    board: boardData(view, context, tasks),
    ...(state.create.kind === "open" ? { create: createData(t, state.create, view.projectId) } : {}),
  }
}
