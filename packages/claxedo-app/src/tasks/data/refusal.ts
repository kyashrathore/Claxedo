import type { Preset, Task, TaskStatus } from "@claxedo/tasks"
import { TasksApiError, TasksClientPayloadError } from "@claxedo/tasks/client"
import type { TasksKey } from "../i18n"

export type FieldReasons = Readonly<Record<string, string>>

export type TasksRefusal = {
  readonly message: string
  readonly fields: FieldReasons
  readonly stale?: { readonly preset?: Preset; readonly task?: Task }
}

export function refusalOf(error: unknown): TasksRefusal {
  if (error instanceof TasksApiError) {
    const fields: Record<string, string> = {}
    for (const field of error.detail.fields ?? []) fields[field.path] = field.reason
    const stale =
      error.code === "stale_revision"
        ? { stale: { preset: error.detail.currentPreset, task: error.detail.currentTask } }
        : {}
    return { message: error.detail.message, fields, ...stale }
  }
  if (error instanceof TasksClientPayloadError) return { message: error.message, fields: {} }
  return { message: error instanceof Error ? error.message : String(error), fields: {} }
}

const FIELD_REASON_KEYS: Readonly<Record<string, TasksKey>> = {
  required: "tasks.field.required",
  too_long: "tasks.field.tooLong",
  too_many: "tasks.field.tooMany",
  duplicate: "tasks.field.duplicate",
  unknown_value: "tasks.field.unknownValue",
  out_of_range: "tasks.field.outOfRange",
  not_allowed: "tasks.field.notAllowed",
}

export function fieldReasonKey(reason: string): TasksKey {
  return FIELD_REASON_KEYS[reason] ?? "tasks.field.refused"
}

export type TaskListFilter = {
  readonly projectId: string
  readonly status: TaskStatus | null
  readonly parent: "any" | "root"
  readonly includeArchived: boolean
}
