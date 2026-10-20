import { TasksApiError, TasksClientPayloadError } from "../client/client"
import type { Preset, Task } from "../contracts"
import type { TasksKey, Translate } from "./dictionary"

export type FieldReasons = Readonly<Record<string, string>>

export type TasksRefusal = {
  readonly message: string
  readonly fields: FieldReasons
  readonly stale?: { readonly preset?: Preset; readonly task?: Task }
}

const TOO_MANY_REQUESTS = 429

function isRateLimited(error: unknown): boolean {
  return (error instanceof TasksApiError || error instanceof TasksClientPayloadError) && error.status === TOO_MANY_REQUESTS
}

export function tasksRefusalOf(error: unknown, t: Translate): TasksRefusal {
  if (isRateLimited(error)) return { message: t("claxedo-tasks.error.rateLimit"), fields: {} }
  if (error instanceof TasksApiError) {
    const fields: Record<string, string> = {}
    for (const field of error.detail.fields ?? []) fields[field.path] = field.reason
    const stale = error.code === "stale_revision" ? { stale: { preset: error.detail.currentPreset, task: error.detail.currentTask } } : {}
    return { message: error.detail.message, fields, ...stale }
  }
  return { message: error instanceof Error ? error.message : String(error), fields: {} }
}

const FIELD_REASON_KEYS: Readonly<Record<string, TasksKey>> = {
  required: "claxedo-tasks.field.required",
  too_long: "claxedo-tasks.field.tooLong",
  too_many: "claxedo-tasks.field.tooMany",
  duplicate: "claxedo-tasks.field.duplicate",
  unknown_value: "claxedo-tasks.field.unknownValue",
  out_of_range: "claxedo-tasks.field.outOfRange",
  not_allowed: "claxedo-tasks.field.notAllowed",
}

export function fieldReason(t: Translate, reason: string): string {
  return t(FIELD_REASON_KEYS[reason] ?? "claxedo-tasks.field.refused")
}
