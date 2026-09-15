import { utf8ByteLength } from "@claxedo/helpers/string"
import { decodeAttachmentData, decodedByteLength } from "../attachments"
import {
  TASKS_BOUNDS,
  isTaskAttachmentMime,
  isTaskCreateStatus,
  type TaskAttachmentDraft,
  type TaskAttachmentMime,
  type TaskDraft,
  type TaskEditInput,
  type TaskReparentInput,
} from "../contracts"
import { collectFields, parsedInvalid, parsedOk, type FieldCollector, type Parsed } from "../validation"

/** A draft attachment with its bytes decoded, which is the only form the store takes. */
export type DecodedAttachmentDraft = {
  filename: string
  mime: TaskAttachmentMime
  bytes: Uint8Array
}

/**
 * The bytes are sized from the base64 length before they are decoded, so an
 * oversized image is refused without allocating it, and are refused whole
 * when the text is not base64: a partial decode would store a truncated image
 * under a name that promises the full one.
 */
function decodeAttachment(
  fields: FieldCollector,
  draft: TaskAttachmentDraft,
  path: string,
): DecodedAttachmentDraft | undefined {
  const name = draft.filename.trim()
  if (name.length === 0) fields.add(`${path}.filename`, "required")
  else if (name.length > TASKS_BOUNDS.taskAttachmentFilenameMax) fields.add(`${path}.filename`, "too_long")
  if (!isTaskAttachmentMime(draft.mime)) fields.add(`${path}.mime`, "unknown_value")
  if (decodedByteLength(draft.data) > TASKS_BOUNDS.taskAttachmentMaxBytes) {
    fields.add(`${path}.data`, "too_long")
    return undefined
  }
  const bytes = decodeAttachmentData(draft.data)
  if (!bytes) {
    fields.add(`${path}.data`, "type")
    return undefined
  }
  return isTaskAttachmentMime(draft.mime) ? { filename: name, mime: draft.mime, bytes } : undefined
}

function decodeAttachments(fields: FieldCollector, drafts: readonly TaskAttachmentDraft[]): DecodedAttachmentDraft[] {
  if (drafts.length > TASKS_BOUNDS.taskAttachmentsMax) {
    fields.add("attachments", "too_many")
    return []
  }
  return drafts.flatMap((draft, index) => decodeAttachment(fields, draft, `attachments[${index}]`) ?? [])
}

function validateTitleAndDescription(fields: FieldCollector, title: string, description: string): void {
  if (title.trim().length === 0) fields.add("title", "required")
  else if (title.length > TASKS_BOUNDS.taskTitleMax) fields.add("title", "too_long")
  if (utf8ByteLength(description) > TASKS_BOUNDS.taskDescriptionMaxBytes) fields.add("description", "too_long")
}

export type ValidatedTaskDraft = { draft: TaskDraft; attachments: readonly DecodedAttachmentDraft[] }

export function validateTaskDraft(draft: TaskDraft): Parsed<ValidatedTaskDraft> {
  const fields = collectFields()
  validateTitleAndDescription(fields, draft.title, draft.description)
  const attachments = decodeAttachments(fields, draft.attachments ?? [])
  if (draft.projectId.trim().length === 0) fields.add("projectId", "required")
  if (draft.workspaceId !== null && draft.workspaceId.trim().length === 0) fields.add("workspaceId", "required")
  if (draft.parentTaskId !== null && draft.parentTaskId.trim().length === 0) fields.add("parentTaskId", "required")
  if (draft.status !== undefined && !isTaskCreateStatus(draft.status)) fields.add("status", "unknown_value")
  if (draft.createdFrom !== undefined) {
    if (draft.createdFrom.sessionId.trim().length === 0) fields.add("createdFrom.sessionId", "required")
    if (draft.createdFrom.workspaceId !== null && draft.createdFrom.workspaceId.trim().length === 0) {
      fields.add("createdFrom.workspaceId", "required")
    }
  }
  return fields.ok ? parsedOk({ draft, attachments }) : parsedInvalid(fields.fields)
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
