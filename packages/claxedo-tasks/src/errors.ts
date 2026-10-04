import type { InvalidField, Preset, Task, TasksErrorCode, TasksErrorDetail } from "./contracts"

export type FailureExtra = {
  fields?: readonly InvalidField[]
  currentPreset?: Preset
  currentTask?: Task
}

export function tasksErrorDetail(code: TasksErrorCode, message: string, extra: FailureExtra = {}): TasksErrorDetail {
  return {
    code,
    message,
    ...(extra.fields ? { fields: extra.fields } : {}),
    ...(extra.currentPreset ? { currentPreset: extra.currentPreset } : {}),
    ...(extra.currentTask ? { currentTask: extra.currentTask } : {}),
  }
}

/**
 * The single failure channel of the services. It is thrown rather than
 * returned so that a refusal inside a store transaction rolls the unit back —
 * the mutation and its command receipt fall together — instead of returning a
 * failure value that leaves a half-written unit committed.
 */
export class TasksError extends Error {
  constructor(readonly detail: TasksErrorDetail) {
    super(detail.message)
    this.name = "TasksError"
  }
}

export function refuse(code: TasksErrorCode, message: string, extra: FailureExtra = {}): never {
  throw new TasksError(tasksErrorDetail(code, message, extra))
}

export function refuseInvalid(message: string, fields: readonly InvalidField[]): never {
  return refuse("invalid_input", message, { fields })
}
