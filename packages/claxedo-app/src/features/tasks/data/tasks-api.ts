import { TASKS_ROUTE_PATH, type Preset, type Task, type TaskStatus } from "@claxedo/tasks"
import { TasksApiError, TasksClientPayloadError, createTasksClient, type TasksClient } from "@claxedo/tasks/client"
import type { FieldErrors } from "@claxedo/tasks/solid"
import { queryKeys } from "@/platform/query/keys"

export { TasksApiError, TasksClientPayloadError }

export function createTasksApi(input: { serverUrl: string; request: (url: string, init?: RequestInit) => Promise<Response> }): TasksClient {
  return createTasksClient({ baseUrl: `${input.serverUrl.replace(/\/+$/, "")}${TASKS_ROUTE_PATH}`, request: input.request })
}

/**
 * The refusal a command came back with, in the shape the editors render.
 *
 * A stale revision is not an error message on its own: it carries the record
 * the server holds, which is what lets a caller rebase its expected revision
 * without discarding what the user typed.
 */
export type TasksRefusal = {
  message: string
  fields: FieldErrors
  stale?: { preset?: Preset; task?: Task }
}

export function refusalOf(error: unknown): TasksRefusal {
  if (error instanceof TasksApiError) {
    const fields: Record<string, string> = {}
    for (const field of error.detail.fields ?? []) fields[field.path] = fieldMessage(field.reason)
    return {
      message: error.detail.message,
      fields,
      ...(error.code === "stale_revision"
        ? { stale: { preset: error.detail.currentPreset, task: error.detail.currentTask } }
        : {}),
    }
  }
  if (error instanceof TasksClientPayloadError) return { message: error.message, fields: {} }
  return { message: error instanceof Error ? error.message : String(error), fields: {} }
}

function fieldMessage(reason: string) {
  switch (reason) {
    case "required":
      return "This field is required."
    case "too_long":
      return "This value is too long."
    case "too_many":
      return "Too many entries."
    case "duplicate":
      return "This entry is listed twice."
    case "unknown_value":
      return "This value is not available here. Choose another rather than accepting a substitute."
    case "out_of_range":
      return "This value is out of range."
    case "not_allowed":
      return "This change is not allowed."
    default:
      return "This value was refused."
  }
}

export type TaskListFilter = {
  projectId: string
  status: TaskStatus | null
  parent: "any" | "root"
  includeArchived: boolean
}

export function tasksQueryKeys(input: { serverUrl: string; scopeId: string }) {
  return {
    scope: queryKeys.tasks.scope(input.serverUrl, input.scopeId),
    capabilities: queryKeys.tasks.capabilities(input.serverUrl, input.scopeId),
    presets: (includeArchived: boolean) => queryKeys.tasks.presets(input.serverUrl, input.scopeId, includeArchived),
    list: (filter: TaskListFilter) => queryKeys.tasks.list(input.serverUrl, input.scopeId, filter),
    detail: (taskId: string) => queryKeys.tasks.detail(input.serverUrl, input.scopeId, taskId),
    children: (taskId: string) => queryKeys.tasks.children(input.serverUrl, input.scopeId, taskId),
  }
}
