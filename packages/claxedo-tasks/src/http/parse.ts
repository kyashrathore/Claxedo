import {
  TASKS_BOUNDS,
  isTaskCreateStatus,
  isTaskStatus,
  isTasksCommandName,
  type ChildListQuery,
  type PresetDraft,
  type PresetListQuery,
  type StartPreviewRequest,
  type StartRequest,
  type TaskListQuery,
  type TasksCommand,
  type TasksCommandRequest,
} from "../contracts"
import { decodeConfigurations, decodeExecution, decodeSessionReference, decodeSlot } from "../decode"
import { clampLimit } from "../paging"
import { decodeContext, finishDecode, parsedInvalid, type DecodeContext, type Parsed } from "../validation"

/**
 * Untrusted JSON in, contract types out. Shape only: a missing key, a wrong
 * type or a value outside a closed union is a named invalid field, never a
 * default and never a coercion. Sizes and semantic rules belong to the model
 * files, which own them for host callers too.
 */

function presetDraft(ctx: DecodeContext, row: Record<string, unknown> | undefined, path: string): PresetDraft {
  return {
    name: ctx.read.string(row?.name, `${path}name`) ?? "",
    instructions: ctx.read.string(row?.instructions, `${path}instructions`) ?? "",
    execution: decodeExecution(ctx, row?.execution, `${path}execution`),
    configurations: decodeConfigurations(ctx, row?.configurations, `${path}configurations`),
  }
}

function commandInput(ctx: DecodeContext, name: TasksCommand["type"], value: unknown): TasksCommand {
  const row = ctx.read.record(value, "command.input")
  const path = "command.input."
  const presetId = () => ctx.read.nonEmptyString(row?.presetId, `${path}presetId`) ?? ""
  const taskId = () => ctx.read.nonEmptyString(row?.taskId, `${path}taskId`) ?? ""
  const revision = () => ctx.read.integer(row?.revision, `${path}revision`) ?? 0

  switch (name) {
    case "preset.create":
      return { type: name, input: presetDraft(ctx, row, path) }
    case "preset.edit":
      return { type: name, input: { presetId: presetId(), revision: revision(), ...presetDraft(ctx, row, path) } }
    case "preset.archive":
    case "preset.restore":
      return { type: name, input: { presetId: presetId(), revision: revision() } }
    case "task.create": {
      // The two optional keys. A client that says nothing about status gets To
      // do, and one that names anything but the two a task may be created in is
      // refused rather than quietly corrected; an absent `createdFrom` is the app.
      const created = row?.status
      if (created !== undefined && !isTaskCreateStatus(created)) ctx.fields.add(`${path}status`, "unknown_value")
      const from = row?.createdFrom
      return {
        type: name,
        input: {
          projectId: ctx.read.nonEmptyString(row?.projectId, `${path}projectId`) ?? "",
          title: ctx.read.string(row?.title, `${path}title`) ?? "",
          description: ctx.read.string(row?.description, `${path}description`) ?? "",
          workspaceId: ctx.read.nullableString(row?.workspaceId, `${path}workspaceId`) ?? null,
          parentTaskId: ctx.read.nullableString(row?.parentTaskId, `${path}parentTaskId`) ?? null,
          ...(isTaskCreateStatus(created) ? { status: created } : {}),
          ...(from === undefined ? {} : { createdFrom: decodeSessionReference(ctx, from, `${path}createdFrom`) }),
        },
      }
    }
    case "task.edit":
      return {
        type: name,
        input: {
          taskId: taskId(),
          revision: revision(),
          title: ctx.read.string(row?.title, `${path}title`) ?? "",
          description: ctx.read.string(row?.description, `${path}description`) ?? "",
          workspaceId: ctx.read.nullableString(row?.workspaceId, `${path}workspaceId`) ?? null,
        },
      }
    case "task.set_status": {
      const status = ctx.read.string(row?.status, `${path}status`)
      if (status !== undefined && !isTaskStatus(status)) ctx.fields.add(`${path}status`, "unknown_value")
      return {
        type: name,
        input: { taskId: taskId(), revision: revision(), status: isTaskStatus(status) ? status : "todo" },
      }
    }
    case "task.reparent":
      return {
        type: name,
        input: {
          taskId: taskId(),
          revision: revision(),
          parentTaskId: ctx.read.nullableString(row?.parentTaskId, `${path}parentTaskId`) ?? null,
          projectId: ctx.read.nonEmptyString(row?.projectId, `${path}projectId`) ?? "",
        },
      }
    case "task.archive":
    case "task.restore":
      return { type: name, input: { taskId: taskId(), revision: revision() } }
    default: {
      const exhaustive: never = name
      return exhaustive
    }
  }
}

export function parseCommandRequest(body: unknown): Parsed<TasksCommandRequest> {
  const ctx = decodeContext()
  const row = ctx.read.record(body, "body")
  const clientRequestId = ctx.read.nonEmptyString(row?.clientRequestId, "clientRequestId") ?? ""
  const command = ctx.read.record(row?.command, "command")
  const name = ctx.read.string(command?.type, "command.type")
  if (!isTasksCommandName(name)) {
    if (name !== undefined) ctx.fields.add("command.type", "unknown_value")
    return parsedInvalid(ctx.fields.fields)
  }
  return finishDecode(ctx, () => ({ clientRequestId, command: commandInput(ctx, name, command?.input) }))
}

export function parseStartPreviewRequest(body: unknown): Parsed<StartPreviewRequest> {
  const ctx = decodeContext()
  const row = ctx.read.record(body, "body")
  return finishDecode(ctx, () => ({
    taskRevision: ctx.read.integer(row?.taskRevision, "taskRevision") ?? 0,
    presetId: ctx.read.nonEmptyString(row?.presetId, "presetId") ?? "",
    presetRevision: ctx.read.integer(row?.presetRevision, "presetRevision") ?? 0,
    slot: decodeSlot(ctx, row?.slot, "slot"),
    attempt: ctx.read.integer(row?.attempt, "attempt") ?? 0,
    continueFromPrevious: ctx.read.boolean(row?.continueFromPrevious, "continueFromPrevious") ?? false,
  }))
}

export function parseStartRequest(body: unknown): Parsed<StartRequest> {
  const ctx = decodeContext()
  const row = ctx.read.record(body, "body")
  const handoff = row?.handoffText
  return finishDecode(ctx, () => ({
    clientRequestId: ctx.read.nonEmptyString(row?.clientRequestId, "clientRequestId") ?? "",
    taskRevision: ctx.read.integer(row?.taskRevision, "taskRevision") ?? 0,
    presetId: ctx.read.nonEmptyString(row?.presetId, "presetId") ?? "",
    presetRevision: ctx.read.integer(row?.presetRevision, "presetRevision") ?? 0,
    slot: decodeSlot(ctx, row?.slot, "slot"),
    attempt: ctx.read.integer(row?.attempt, "attempt") ?? 0,
    previewDigest: ctx.read.nonEmptyString(row?.previewDigest, "previewDigest") ?? "",
    handoffText: handoff === null ? null : (ctx.read.boundedText(handoff, "handoffText", TASKS_BOUNDS.handoffTextMaxBytes) ?? null),
    continueFromPrevious: ctx.read.boolean(row?.continueFromPrevious, "continueFromPrevious") ?? false,
  }))
}

function queryInteger(ctx: DecodeContext, params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key)
  if (raw === null) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    ctx.fields.add(key, "type")
    return undefined
  }
  return value
}

function queryBoolean(ctx: DecodeContext, params: URLSearchParams, key: string): boolean {
  const raw = params.get(key)
  if (raw === null) return false
  if (raw === "true") return true
  if (raw === "false") return false
  ctx.fields.add(key, "type")
  return false
}

/** A browser is told its limit is out of range where a host caller is clamped, off the one rule. */
function queryLimit(ctx: DecodeContext, params: URLSearchParams): number {
  const limit = queryInteger(ctx, params, "limit")
  if (limit === undefined) return TASKS_BOUNDS.listLimitDefault
  const clamped = clampLimit(limit)
  if (clamped !== limit) {
    ctx.fields.add("limit", "out_of_range")
    return TASKS_BOUNDS.listLimitDefault
  }
  return limit
}

export function parsePresetListQuery(params: URLSearchParams): Parsed<PresetListQuery> {
  const ctx = decodeContext()
  return finishDecode(ctx, () => ({
    cursor: params.get("cursor"),
    limit: queryLimit(ctx, params),
    includeArchived: queryBoolean(ctx, params, "includeArchived"),
  }))
}

export function parseTaskListQuery(params: URLSearchParams): Parsed<TaskListQuery> {
  const ctx = decodeContext()
  const projectId = params.get("projectId")
  if (projectId === null || projectId.length === 0) ctx.fields.add("projectId", "required")
  const status = params.get("status")
  if (status !== null && !isTaskStatus(status)) ctx.fields.add("status", "unknown_value")
  const parent = params.get("parent")
  if (parent !== null && parent !== "any" && parent !== "root") ctx.fields.add("parent", "unknown_value")
  return finishDecode(ctx, () => ({
    projectId: projectId ?? "",
    status: isTaskStatus(status) ? status : null,
    parent: parent === "root" ? "root" : "any",
    cursor: params.get("cursor"),
    limit: queryLimit(ctx, params),
    includeArchived: queryBoolean(ctx, params, "includeArchived"),
  }))
}

export function parseChildListQuery(params: URLSearchParams): Parsed<ChildListQuery> {
  const ctx = decodeContext()
  return finishDecode(ctx, () => ({
    cursor: params.get("cursor"),
    limit: queryLimit(ctx, params),
    includeArchived: queryBoolean(ctx, params, "includeArchived"),
  }))
}

