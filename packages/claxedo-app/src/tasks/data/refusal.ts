import type { Preset, StartBlocker, Task, TaskStatus } from "@claxedo/tasks"
import { TasksApiError, TasksClientPayloadError } from "@claxedo/tasks/client"
import { ServerError } from "@/server"
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

const TOO_MANY_REQUESTS = 429

export function rateLimitOf(error: unknown): ServerError | undefined {
  if (!(error instanceof TasksApiError || error instanceof TasksClientPayloadError) || error.status !== TOO_MANY_REQUESTS) return undefined
  return new ServerError({ class: "rate_limit", message: error.message, status: error.status, cause: error })
}

export function startBlockerRateLimit(blocker: StartBlocker): ServerError | undefined {
  return blocker.code === "rate_limited" ? new ServerError({ class: "rate_limit", message: blocker.detail, code: blocker.code }) : undefined
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
