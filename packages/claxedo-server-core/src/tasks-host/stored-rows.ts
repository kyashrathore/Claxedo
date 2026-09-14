/**
 * The column shapes both durable Tasks adapters write, and the one place a
 * stored row becomes a kit record again.
 *
 * Reading goes through the kit's own wire decoders. A row written by an older
 * build, or hand-edited, is then refused with the field that is wrong instead
 * of entering the services as a record whose type nothing checked — and the
 * SQLite and D1 adapters cannot drift into two different answers about what a
 * stored preset means.
 */
import {
  decodeCommandResponse,
  decodePreset,
  decodeTask,
  PRESET_PLACEMENTS,
  isConfigurationSlot,
  isSessionStarter,
  isTasksCommandName,
  type Preset,
  type PresetPlacement,
  type SessionReference,
  type Task,
  type TaskSessionLink,
  type TasksCommandReceipt,
} from "@claxedo/tasks"
import { parseJson } from "@claxedo/server-core/platform/json/index"

export class TasksStoredRowError extends Error {}

export type StoredPresetColumns = {
  scope_id: string
  preset_id: string
  revision: number
  owner_id: string
  name: string
  instructions: string
  execution: string
  configurations: string
  agent_startable: number
  archived_at: number | null
  created_at: number
  updated_at: number
}

export type StoredTaskColumns = {
  scope_id: string
  task_id: string
  revision: number
  project_id: string
  number: number
  workspace_id: string | null
  parent_task_id: string | null
  created_from_session_id: string | null
  created_from_workspace_id: string | null
  title: string
  description: string
  status: string
  child_set_revision: number
  archived_at: number | null
  created_at: number
  updated_at: number
}

export type StoredLinkColumns = {
  scope_id: string
  task_id: string
  slot: string
  attempt: number
  session_id: string
  session_workspace_id: string | null
  continued_from_session_id: string | null
  continued_from_workspace_id: string | null
  preset_id: string
  preset_revision: number
  preset_name_at_start: string
  configuration_digest: string
  handoff_text: string | null
  started_from_session_id: string | null
  started_from_workspace_id: string | null
  started_by: string
  placement: string
  created_at: number
}

export type StoredReceiptColumns = {
  scope_id: string
  client_request_id: string
  command_name: string
  request_hash: string
  result: string
  created_at: number
}

export function presetColumns(preset: Preset): StoredPresetColumns {
  return {
    scope_id: preset.scopeId,
    preset_id: preset.id,
    revision: preset.revision,
    owner_id: preset.ownerId,
    name: preset.name,
    instructions: preset.instructions,
    execution: JSON.stringify(preset.execution),
    configurations: JSON.stringify(preset.configurations),
    agent_startable: preset.agentStartable ? 1 : 0,
    archived_at: preset.archivedAt,
    created_at: preset.createdAt,
    updated_at: preset.updatedAt,
  }
}

export function presetOfColumns(row: StoredPresetColumns): Preset {
  const decoded = decodePreset({
    id: row.preset_id,
    revision: row.revision,
    scopeId: row.scope_id,
    ownerId: row.owner_id,
    name: row.name,
    instructions: row.instructions,
    execution: parseJson(row.execution),
    configurations: parseJson(row.configurations),
    agentStartable: row.agent_startable === 1,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
  if (!decoded.ok) throw storedRowError("preset", row.preset_id, decoded.fields)
  return decoded.value
}

export function taskColumns(task: Task): StoredTaskColumns {
  return {
    scope_id: task.scopeId,
    task_id: task.id,
    revision: task.revision,
    project_id: task.projectId,
    number: task.number,
    workspace_id: task.workspaceId,
    parent_task_id: task.parentTaskId,
    created_from_session_id: task.createdFrom?.sessionId ?? null,
    created_from_workspace_id: task.createdFrom?.workspaceId ?? null,
    title: task.title,
    description: task.description,
    status: task.status,
    child_set_revision: task.childSetRevision,
    archived_at: task.archivedAt,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  }
}

export function taskOfColumns(row: StoredTaskColumns): Task {
  // A workspace without its session is a half-written origin, not "created
  // from the workspace": the pair is stored and read together, and a session
  // that belongs to no workspace stores a null workspace.
  const createdFrom: SessionReference | null =
    row.created_from_session_id === null
      ? null
      : { sessionId: row.created_from_session_id, workspaceId: row.created_from_workspace_id }
  const decoded = decodeTask({
    id: row.task_id,
    revision: row.revision,
    scopeId: row.scope_id,
    projectId: row.project_id,
    number: row.number,
    workspaceId: row.workspace_id,
    parentTaskId: row.parent_task_id,
    createdFrom,
    title: row.title,
    description: row.description,
    status: row.status,
    childSetRevision: row.child_set_revision,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })
  if (!decoded.ok) throw storedRowError("task", row.task_id, decoded.fields)
  return decoded.value
}

export function linkColumns(link: TaskSessionLink): StoredLinkColumns {
  return {
    scope_id: link.scopeId,
    task_id: link.taskId,
    slot: link.slot,
    attempt: link.attempt,
    session_id: link.sessionRef.sessionId,
    session_workspace_id: link.sessionRef.workspaceId,
    continued_from_session_id: link.continuedFrom?.sessionId ?? null,
    continued_from_workspace_id: link.continuedFrom?.workspaceId ?? null,
    preset_id: link.presetId,
    preset_revision: link.presetRevision,
    preset_name_at_start: link.presetNameAtStart,
    configuration_digest: link.configurationDigest,
    handoff_text: link.handoffText,
    started_from_session_id: link.startedFrom?.sessionId ?? null,
    started_from_workspace_id: link.startedFrom?.workspaceId ?? null,
    started_by: link.startedBy,
    placement: link.placement,
    created_at: link.createdAt,
  }
}

function isPresetPlacement(value: string): value is PresetPlacement {
  return PRESET_PLACEMENTS.some((placement) => placement === value)
}

export function linkOfColumns(row: StoredLinkColumns): TaskSessionLink {
  if (!isConfigurationSlot(row.slot)) {
    throw new TasksStoredRowError(`Stored task session link ${row.task_id} names an unknown slot ${row.slot}`)
  }
  if (!isPresetPlacement(row.placement)) {
    throw new TasksStoredRowError(`Stored task session link ${row.task_id} names an unknown placement ${row.placement}`)
  }
  if (!isSessionStarter(row.started_by)) {
    throw new TasksStoredRowError(`Stored task session link ${row.task_id} names an unknown starter ${row.started_by}`)
  }
  // A continued-from workspace without its session is a half-written origin,
  // not "continued from the workspace": the pair is stored and read together.
  const continuedFrom: SessionReference | null =
    row.continued_from_session_id === null
      ? null
      : { sessionId: row.continued_from_session_id, workspaceId: row.continued_from_workspace_id }
  const startedFrom: SessionReference | null =
    row.started_from_session_id === null
      ? null
      : { sessionId: row.started_from_session_id, workspaceId: row.started_from_workspace_id }
  return {
    scopeId: row.scope_id,
    taskId: row.task_id,
    slot: row.slot,
    attempt: row.attempt,
    sessionRef: { sessionId: row.session_id, workspaceId: row.session_workspace_id },
    continuedFrom,
    presetId: row.preset_id,
    presetRevision: row.preset_revision,
    presetNameAtStart: row.preset_name_at_start,
    configurationDigest: row.configuration_digest,
    handoffText: row.handoff_text,
    startedFrom,
    startedBy: row.started_by,
    placement: row.placement,
    createdAt: row.created_at,
  }
}

export function receiptColumns(receipt: TasksCommandReceipt): StoredReceiptColumns {
  return {
    scope_id: receipt.scopeId,
    client_request_id: receipt.clientRequestId,
    command_name: receipt.commandName,
    request_hash: receipt.requestHash,
    result: JSON.stringify(receipt.result),
    created_at: receipt.createdAt,
  }
}

export function receiptOfColumns(row: StoredReceiptColumns): TasksCommandReceipt {
  if (!isTasksCommandName(row.command_name)) {
    throw new TasksStoredRowError(
      `Stored command receipt ${row.client_request_id} names an unknown command ${row.command_name}`,
    )
  }
  const decoded = decodeCommandResponse({ result: parseJson(row.result), replayed: true })
  if (!decoded.ok) throw storedRowError("command receipt", row.client_request_id, decoded.fields)
  if (decoded.value.result.type !== row.command_name) {
    throw new TasksStoredRowError(
      `Stored command receipt ${row.client_request_id} carries a ${decoded.value.result.type} result under ${row.command_name}`,
    )
  }
  return {
    scopeId: row.scope_id,
    clientRequestId: row.client_request_id,
    commandName: row.command_name,
    requestHash: row.request_hash,
    result: decoded.value.result,
    createdAt: row.created_at,
  }
}

function storedRowError(kind: string, id: string, fields: readonly { path: string; reason: string }[]) {
  const detail = fields.map((field) => `${field.path} (${field.reason})`).join(", ")
  return new TasksStoredRowError(`Stored ${kind} ${id} cannot be read: ${detail}`)
}
