import { utf8ByteLength } from "@claxedo/helpers/string"
import { TASKS_BOUNDS, isTaskCreateStatus, type TaskDraft, type TaskEditInput, type TaskReparentInput } from "../contracts"
import { collectFields, parsedInvalid, parsedOk, type FieldCollector, type Parsed } from "../validation"

function validateTitleAndDescription(fields: FieldCollector, title: string, description: string): void {
  if (title.trim().length === 0) fields.add("title", "required")
  else if (title.length > TASKS_BOUNDS.taskTitleMax) fields.add("title", "too_long")
  if (utf8ByteLength(description) > TASKS_BOUNDS.taskDescriptionMaxBytes) fields.add("description", "too_long")
}

export function validateTaskDraft(draft: TaskDraft): Parsed<TaskDraft> {
  const fields = collectFields()
  validateTitleAndDescription(fields, draft.title, draft.description)
  if (draft.projectId.trim().length === 0) fields.add("projectId", "required")
  if (draft.workspaceId !== null && draft.workspaceId.trim().length === 0) fields.add("workspaceId", "required")
  if (draft.parentTaskId !== null && draft.parentTaskId.trim().length === 0) fields.add("parentTaskId", "required")
  if (draft.status !== undefined && !isTaskCreateStatus(draft.status)) fields.add("status", "unknown_value")
  return fields.ok ? parsedOk(draft) : parsedInvalid(fields.fields)
}

export function validateTaskEdit(input: TaskEditInput): Parsed<TaskEditInput> {
  const fields = collectFields()
  validateTitleAndDescription(fields, input.title, input.description)
  if (input.workspaceId !== null && input.workspaceId.trim().length === 0) fields.add("workspaceId", "required")
  return fields.ok ? parsedOk(input) : parsedInvalid(fields.fields)
}

/** The cycle this can see without a store read; depth and project rules are the service's. */
export function validateReparent(input: TaskReparentInput): Parsed<TaskReparentInput> {
  const fields = collectFields()
  if (input.projectId.trim().length === 0) fields.add("projectId", "required")
  if (input.parentTaskId !== null) {
    if (input.parentTaskId.trim().length === 0) fields.add("parentTaskId", "required")
    else if (input.parentTaskId === input.taskId) fields.add("parentTaskId", "not_allowed")
  }
  return fields.ok ? parsedOk(input) : parsedInvalid(fields.fields)
}
