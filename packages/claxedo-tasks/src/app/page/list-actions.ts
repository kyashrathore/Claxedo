import type { SurfaceActionEvent } from "@claxedo/plugin-api"
import { isTaskCreateStatus, isTaskStatus, type TaskStatus, type TaskSummary } from "../../contracts"
import type { Json } from "../surface/json"
import { openForm, pickedImages, type createTaskCreation } from "./create-commands"
import { PAGE_EVENTS } from "./events"
import { nextStatus, previousStatus, TASK_COLLECTIONS, TASK_DATE_FIELDS } from "./model"
import type { PageModel } from "./page-model"
import type { StartCommands } from "./start-commands"
import { startWithPreset, type PageState } from "./state"
import type { TaskCommands } from "./task-commands"

export type ListHandlers = {
  readonly model: PageModel
  readonly commands: TaskCommands
  readonly starts: StartCommands
  readonly create: ReturnType<typeof createTaskCreation>
  readonly reload: () => Promise<void>
  readonly more: () => Promise<void>
  readonly nextKey: () => string
  readonly nextForm: () => number
}

export function contextText(action: SurfaceActionEvent, key: string): string {
  const value = action.context[key]
  return typeof value === "string" ? value : ""
}

function firstChoice(action: SurfaceActionEvent): string | undefined {
  const value = action.context.value
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined
}

export function knownTask(state: PageState, taskId: string): TaskSummary | undefined {
  const listed = state.list.kind === "ready" ? state.list.tasks.find((task) => task.id === taskId) : undefined
  const child = state.detail?.load.kind === "ready" ? state.detail.load.children.find((task) => task.id === taskId) : undefined
  return listed ?? child
}

function observeControl(handlers: ListHandlers, path: string, action: SurfaceActionEvent) {
  const value = action.context.value as Json | undefined
  if (value !== undefined) handlers.model.sync.observe(path, value)
}

function controlChange(handlers: ListHandlers, action: SurfaceActionEvent): boolean {
  const { model } = handlers
  const choice = firstChoice(action)
  switch (action.name) {
    case PAGE_EVENTS.view:
      observeControl(handlers, "/controls/view", action)
      if (choice === "list" || choice === "board") model.patch({ view: choice })
      return true
    case PAGE_EVENTS.startWith:
      observeControl(handlers, "/controls/startWith", action)
      if (choice) model.patch({ startWith: choice })
      return true
    case PAGE_EVENTS.dateField:
      observeControl(handlers, "/controls/date", action)
      if (choice === TASK_DATE_FIELDS[0] || choice === TASK_DATE_FIELDS[1]) model.patch({ dateField: choice })
      return true
    case PAGE_EVENTS.grouped:
      observeControl(handlers, "/controls/grouped", action)
      model.patch({ grouped: action.context.value === true })
      return true
    default:
      return false
  }
}

function filterChange(handlers: ListHandlers, action: SurfaceActionEvent): boolean {
  const { model } = handlers
  if (action.name === PAGE_EVENTS.collection) {
    observeControl(handlers, "/controls/collection", action)
    const index = action.context.index
    const collection = typeof index === "number" ? TASK_COLLECTIONS[index] : undefined
    if (!collection) return true
    const refetch = (collection === "all") !== (model.state().collection === "all")
    model.patch({ collection })
    if (refetch) void handlers.reload()
    return true
  }
  if (action.name === PAGE_EVENTS.statusFilter) {
    observeControl(handlers, "/controls/status", action)
    const choice = firstChoice(action)
    model.patch({ statusFilter: isTaskStatus(choice) ? choice : null })
  } else if (action.name === PAGE_EVENTS.showChildren) {
    observeControl(handlers, "/controls/showChildren", action)
    model.patch({ showChildren: action.context.value === true })
  } else if (action.name === PAGE_EVENTS.project) {
    observeControl(handlers, "/controls/project", action)
    const projectId = contextText(action, "value")
    if (projectId) model.patch({ chosenProjectId: projectId })
  } else return false
  void handlers.reload()
  return true
}

function moveTask(handlers: ListHandlers, action: SurfaceActionEvent) {
  const { model } = handlers
  const task = knownTask(model.state(), contextText(action, "itemId"))
  const from = contextText(action, "fromColumn")
  const to = contextText(action, "toColumn")
  model.sync.force(`/board/${from}`)
  model.sync.force(`/board/${to}`)
  if (!task || !isTaskStatus(to) || from === to) return model.patch({})
  model.patch((state) => (state.list.kind === "ready" ? { list: { ...state.list, tasks: state.list.tasks.map((entry) => (entry.id === task.id ? { ...entry, status: to } : entry)) } } : {}))
  void handlers.commands.setStatus(task, to)
}

function taskTool(handlers: ListHandlers, action: SurfaceActionEvent) {
  const state = handlers.model.state()
  const task = knownTask(state, contextText(action, "taskId"))
  if (!task) return
  const tool = contextText(action, "tool")
  const preset = startWithPreset(state)
  const target: TaskStatus | undefined = tool === "next" ? nextStatus(task.status) : tool === "previous" ? previousStatus(task.status) : undefined
  if (tool === "start" && preset) void handlers.starts.start(task, preset, "primary")
  else if (tool === "session") void handlers.starts.openLatest(task)
  else if (target) void handlers.commands.setStatus(task, target)
}

function createAction(handlers: ListHandlers, action: SurfaceActionEvent): boolean {
  const { model } = handlers
  const form = model.state().create
  switch (action.name) {
    case PAGE_EVENTS.openCreate:
      model.patch({ create: openForm(handlers.nextForm(), "todo") })
      return true
    case PAGE_EVENTS.boardCreate: {
      const status = contextText(action, "status")
      model.patch({ create: openForm(handlers.nextForm(), isTaskCreateStatus(status) ? status : "todo") })
      return true
    }
    case PAGE_EVENTS.cancelCreate:
      model.patch({ create: { kind: "closed" } })
      return true
    case PAGE_EVENTS.createImages:
      if (form.kind === "open") model.patch({ create: pickedImages(model.deps.t, form, action.context.files, action.context.refused, handlers.nextKey) })
      return true
    case PAGE_EVENTS.removeImage:
      if (form.kind === "open") model.patch({ create: { ...form, images: form.images.filter((image) => image.key !== contextText(action, "key")), imageRefusals: [] } })
      return true
    case PAGE_EVENTS.submitCreate:
      void handlers.create({ title: action.sourceComponentId === "create-title" ? contextText(action, "value") : contextText(action, "title"), description: contextText(action, "description"), status: action.context.status, projectId: contextText(action, "project") })
      return true
    default:
      return false
  }
}

export function taskListAction(handlers: ListHandlers, action: SurfaceActionEvent): boolean {
  if (controlChange(handlers, action) || filterChange(handlers, action) || createAction(handlers, action)) return true
  const { model } = handlers
  switch (action.name) {
    case PAGE_EVENTS.openPresets:
      model.deps.openPresets()
      return true
    case PAGE_EVENTS.retryList:
      void handlers.reload()
      return true
    case PAGE_EVENTS.loadMore:
      void handlers.more()
      return true
    case PAGE_EVENTS.openTask:
      model.deps.openPage({ taskId: contextText(action, "taskId") })
      return true
    case PAGE_EVENTS.taskTool:
      taskTool(handlers, action)
      return true
    case PAGE_EVENTS.moveTask:
      moveTask(handlers, action)
      return true
    default:
      return false
  }
}
