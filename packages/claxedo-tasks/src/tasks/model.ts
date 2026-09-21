import { utf8ByteLength } from "@claxedo/helpers/string"
import { decodeAttachmentData, decodedByteLength, sniffedAttachmentMime } from "../attachments"
import {
  TASKS_BOUNDS,
  isTaskAttachmentMime,
  isTaskCreateStatus,
  type SessionReference,
  type StartPreviewRequest,
  type StartRequest,
  type TaskAttachmentDraft,
  type TaskAttachmentMime,
  type TaskDraft,
  type TaskEditInput,
  type TaskReparentInput,
} from "../contracts"
import { collectFields, idWithinBound, parsedInvalid, parsedOk, type FieldCollector, type Parsed } from "../validation"

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
  if (!isTaskAttachmentMime(draft.mime)) return undefined
  // The declared type is a claim; the signature is what the bytes are, so a
  // label they do not carry is refused rather than stored and served under it.
  if (sniffedAttachmentMime(bytes) !== draft.mime) {
    fields.add(`${path}.data`, "not_allowed")
    return undefined
  }
  return { filename: name, mime: draft.mime, bytes }
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

/** Every id is a key a receipt row, an index or an adapter lookup is built from, so each is held to the same bound. */
function boundedId(fields: FieldCollector, value: string, path: string): void {
  if (!idWithinBound(value)) fields.add(path, "too_long")
}

function nullableBoundedId(fields: FieldCollector, value: string | null, path: string): void {
  if (value !== null) boundedId(fields, value, path)
}

function sessionReferenceFields(fields: FieldCollector, reference: SessionReference, path: string): void {
  if (reference.sessionId.trim().length === 0) fields.add(`${path}.sessionId`, "required")
  else boundedId(fields, reference.sessionId, `${path}.sessionId`)
  if (reference.workspaceId !== null && reference.workspaceId.trim().length === 0) {
    fields.add(`${path}.workspaceId`, "required")
  } else {
    nullableBoundedId(fields, reference.workspaceId, `${path}.workspaceId`)
  }
}

export type ValidatedTaskDraft = { draft: TaskDraft; attachments: readonly DecodedAttachmentDraft[] }

export function validateTaskDraft(draft: TaskDraft): Parsed<ValidatedTaskDraft> {
  const fields = collectFields()
  validateTitleAndDescription(fields, draft.title, draft.description)
  const attachments = decodeAttachments(fields, draft.attachments ?? [])
  if (draft.projectId.trim().length === 0) fields.add("projectId", "required")
  else boundedId(fields, draft.projectId, "projectId")
  if (draft.workspaceId !== null && draft.workspaceId.trim().length === 0) fields.add("workspaceId", "required")
  else nullableBoundedId(fields, draft.workspaceId, "workspaceId")
  if (draft.parentTaskId !== null && draft.parentTaskId.trim().length === 0) fields.add("parentTaskId", "required")
  else nullableBoundedId(fields, draft.parentTaskId, "parentTaskId")
  if (draft.status !== undefined && !isTaskCreateStatus(draft.status)) fields.add("status", "unknown_value")
  if (draft.createdFrom !== undefined) sessionReferenceFields(fields, draft.createdFrom, "createdFrom")
  return fields.ok ? parsedOk({ draft, attachments }) : parsedInvalid(fields.fields)
}

export function validateTaskEdit(input: TaskEditInput): Parsed<TaskEditInput> {
  const fields = collectFields()
  validateTitleAndDescription(fields, input.title, input.description)
  boundedId(fields, input.taskId, "taskId")
  if (input.workspaceId !== null && input.workspaceId.trim().length === 0) fields.add("workspaceId", "required")
  else nullableBoundedId(fields, input.workspaceId, "workspaceId")
  return fields.ok ? parsedOk(input) : parsedInvalid(fields.fields)
}

/** The cycle this can see without a store read; depth and project rules are the service's. */
export function validateReparent(input: TaskReparentInput): Parsed<TaskReparentInput> {
  const fields = collectFields()
  boundedId(fields, input.taskId, "taskId")
  if (input.projectId.trim().length === 0) fields.add("projectId", "required")
  else boundedId(fields, input.projectId, "projectId")
  if (input.parentTaskId !== null) {
    if (input.parentTaskId.trim().length === 0) fields.add("parentTaskId", "required")
    else if (input.parentTaskId === input.taskId) fields.add("parentTaskId", "not_allowed")
    else boundedId(fields, input.parentTaskId, "parentTaskId")
  }
  return fields.ok ? parsedOk(input) : parsedInvalid(fields.fields)
}

function validateStartFields(
  fields: FieldCollector,
  request: Pick<StartRequest, "presetId" | "startedFrom">,
): void {
  if (request.presetId.trim().length === 0) fields.add("presetId", "required")
  else boundedId(fields, request.presetId, "presetId")
  if (request.startedFrom !== undefined) sessionReferenceFields(fields, request.startedFrom, "startedFrom")
}

export function validateStartPreview(request: StartPreviewRequest): Parsed<StartPreviewRequest> {
  const fields = collectFields()
  validateStartFields(fields, request)
  return fields.ok ? parsedOk(request) : parsedInvalid(fields.fields)
}

export function validateStart(request: StartRequest): Parsed<StartRequest> {
  const fields = collectFields()
  validateStartFields(fields, request)
  if (request.clientRequestId.trim().length === 0) fields.add("clientRequestId", "required")
  else boundedId(fields, request.clientRequestId, "clientRequestId")
  if (request.previewDigest.trim().length === 0) fields.add("previewDigest", "required")
  else boundedId(fields, request.previewDigest, "previewDigest")
  if (request.handoffText !== null && utf8ByteLength(request.handoffText) > TASKS_BOUNDS.handoffTextMaxBytes) {
    fields.add("handoffText", "too_long")
  }
  return fields.ok ? parsedOk(request) : parsedInvalid(fields.fields)
}
