import type { SurfaceActionEvent } from "@claxedo/plugin-api"
import { isConfigurationSlot, isTaskStatus, type ConfigurationSlot, type Task } from "../../contracts"
import { PAGE_EVENTS } from "./events"
import { contextText } from "./list-actions"
import { groupLinksBySlot, presetsForSlot, slotAttempt } from "./model"
import type { PageModel } from "./page-model"
import type { StartCommands } from "./start-commands"
import { activePresets, type TaskDetail } from "./state"
import type { TaskCommands } from "./task-commands"

export type DetailHandlers = {
  readonly model: PageModel
  readonly commands: TaskCommands
  readonly starts: StartCommands
  readonly loadDetail: (taskId: string) => Promise<void>
}

function loadedTask(detail: TaskDetail | undefined): Task | undefined {
  return detail?.load.kind === "ready" ? detail.load.detail.task : undefined
}

function observeText(model: PageModel, path: string, value: string) {
  model.sync.observe(path, value)
}

function editValues(action: SurfaceActionEvent): { readonly title: string; readonly description: string } {
  if (action.sourceComponentId === "detail-title") return { title: contextText(action, "value"), description: contextText(action, "description") }
  if (action.sourceComponentId === "detail-description") return { title: contextText(action, "title"), description: contextText(action, "value") }
  return { title: contextText(action, "title"), description: contextText(action, "description") }
}

function editAction(handlers: DetailHandlers, action: SurfaceActionEvent, task: Task): boolean {
  const { model, commands } = handlers
  if (action.name === PAGE_EVENTS.save || action.name === PAGE_EVENTS.discard) {
    const values = editValues(action)
    observeText(model, "/detail/title", values.title)
    observeText(model, "/detail/description", values.description)
    if (action.name === PAGE_EVENTS.save) void commands.save(task, values.title, values.description)
    else model.patch((state) => (state.detail ? { detail: { ...state.detail, conflictTitle: undefined, error: undefined, edit: { title: task.title, description: task.description }, revision: task.revision } } : {}))
    return true
  }
  if (action.name === PAGE_EVENTS.addSubtask) {
    const title = action.sourceComponentId === "detail-subtask-new" ? contextText(action, "value") : contextText(action, "title")
    observeText(model, "/detail/newSubtask", title)
    void commands.addSubtask(task, title)
    model.patch({})
    return true
  }
  if (action.name === PAGE_EVENTS.status) {
    const value = action.context.value
    const status = Array.isArray(value) ? value[0] : undefined
    if (Array.isArray(value)) model.sync.observe("/detail/status", value)
    if (isTaskStatus(status) && status !== task.status) void commands.setStatus({ ...task, revision: model.state().detail?.revision ?? task.revision }, status)
    return true
  }
  return false
}

function actionSlot(action: SurfaceActionEvent): ConfigurationSlot | undefined {
  const slot = contextText(action, "slot")
  return isConfigurationSlot(slot) ? slot : undefined
}

function slotAction(handlers: DetailHandlers, action: SurfaceActionEvent, task: Task, detail: TaskDetail): boolean {
  const { model, starts } = handlers
  const slot = actionSlot(action)
  if (!slot || detail.load.kind !== "ready") return false
  const groups = groupLinksBySlot(detail.load.detail.links)
  const next = slotAttempt(groups, slot)
  const offered = presetsForSlot(activePresets(model.state()), slot)
  const choice = (value: unknown) => (Array.isArray(value) && typeof value[0] === "string" ? value[0] : undefined)
  switch (action.name) {
    case PAGE_EVENTS.slotPreset: {
      const value = action.context.value
      if (Array.isArray(value)) model.sync.observe(`/detail/slots/${slot}/preset`, value)
      const presetId = choice(value)
      if (presetId) model.patch({ detail: { ...detail, slotPresets: { ...detail.slotPresets, [slot]: presetId } } })
      return true
    }
    case PAGE_EVENTS.slotStart: {
      const preset = offered.find((entry) => entry.id === choice(action.context.preset)) ?? offered[0]
      if (preset) void starts.start(task, preset, slot)
      return true
    }
    case PAGE_EVENTS.slotContinue: {
      const preset = offered.find((entry) => entry.id === next.current?.presetId)
      if (preset) void starts.start(task, preset, slot, true)
      return true
    }
    case PAGE_EVENTS.slotOpen:
      void starts.openLink(task, next.open)
      return true
    case PAGE_EVENTS.slotSend:
      if (next.open) void starts.sendTask(task, next.open)
      return true
    case PAGE_EVENTS.attemptOpen:
      void starts.openLink(task, groups.find((group) => group.slot === slot)?.attempts.find((link) => link.attempt === action.context.attempt))
      return true
    default:
      return false
  }
}

function navigationAction(handlers: DetailHandlers, action: SurfaceActionEvent, task: Task | undefined, detail: TaskDetail): boolean {
  const { model } = handlers
  switch (action.name) {
    case PAGE_EVENTS.back:
      model.deps.openPage()
      return true
    case PAGE_EVENTS.retryDetail:
      void handlers.loadDetail(detail.taskId)
      return true
    case PAGE_EVENTS.openParent:
      if (task?.parentTaskId) model.deps.openPage({ taskId: task.parentTaskId })
      return true
    case PAGE_EVENTS.openSource:
      if (task?.createdFrom) void model.deps.openSession(task.createdFrom)
      return true
    case PAGE_EVENTS.archive:
    case PAGE_EVENTS.restore:
      if (task) void handlers.commands.archive(task, action.name === PAGE_EVENTS.restore)
      return true
    default:
      return false
  }
}

export function detailAction(handlers: DetailHandlers, action: SurfaceActionEvent): boolean {
  const detail = handlers.model.state().detail
  if (!detail) return false
  const task = loadedTask(detail)
  if (navigationAction(handlers, action, task, detail)) return true
  if (!task) return false
  return editAction(handlers, action, task) || slotAction(handlers, action, task, detail)
}
