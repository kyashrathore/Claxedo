/**
 * Every record, request and response the Tasks kit exchanges with a host or a
 * client. Nothing here imports a host type: the package defines its own actor
 * and session/harness references, and hosts map their principals into them.
 */

export const TASKS_ROUTE_PATH = "/api/claxedo/tasks"

/** Bumped when a request or response shape below changes incompatibly. */
export const TASKS_PROTOCOL_VERSION = 1

export const CONFIGURATION_SLOTS = ["primary", "planning", "implementation", "review"] as const
export type ConfigurationSlot = (typeof CONFIGURATION_SLOTS)[number]

export const TASK_STATUSES = ["backlog", "todo", "doing", "needs_you", "done"] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/**
 * The statuses a task may be created in. The rest are reached by working on
 * it, so offering them at create would name a state nothing has entered.
 */
export const TASK_CREATE_STATUSES = ["backlog", "todo"] as const
export type TaskCreateStatus = (typeof TASK_CREATE_STATUSES)[number]

export const PRESET_PLACEMENTS = ["local", "cloud"] as const
export type PresetPlacement = (typeof PRESET_PLACEMENTS)[number]

export const TASKS_ERROR_CODES = ["invalid_input", "not_found", "forbidden", "stale_revision", "conflict", "unsupported"] as const
export type TasksErrorCode = (typeof TASKS_ERROR_CODES)[number]

/** The image types every harness's prompt inputs carry, so an attachment never needs a workspace path to reach an agent. */
export const TASK_ATTACHMENT_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const
export type TaskAttachmentMime = (typeof TASK_ATTACHMENT_MIMES)[number]

export const TASKS_BOUNDS = {
  presetNameMax: 100,
  instructionsMaxBytes: 64 * 1024,
  taskTitleMax: 200,
  taskDescriptionMaxBytes: 64 * 1024,
  pluginReferencesMax: 128,
  skillReferencesMax: 256,
  handoffTextMaxBytes: 16 * 1024,
  taskAttachmentsMax: 6,
  /**
   * Decoded bytes per image. D1 refuses a row past 2,000,000 bytes, and the
   * row holds the image whole beside its key and name.
   */
  taskAttachmentMaxBytes: 1_572_864,
  taskAttachmentFilenameMax: 255,
  listLimitDefault: 50,
  listLimitMax: 100,
  /**
   * A create carries its images inline as base64 (4/3 of the bytes) on top of
   * the 512 KiB the text fields and a preset's 384 capability references need.
   */
  commandRequestMaxBytes: 512 * 1024 + 6 * 2 * 1024 * 1024,
  startRequestMaxBytes: 64 * 1024,
} as const

/** The same keys as `TASKS_BOUNDS`, widened so a response can carry another host's numbers. */
export type TasksBounds = { readonly [Key in keyof typeof TASKS_BOUNDS]: number }

export type TasksActor = {
  scopeId: string
  ownerId: string
}

export type SessionReference = {
  sessionId: string
  workspaceId: string | null
}

export type HarnessReference = {
  id: string
  access: "native" | "connection"
}

export type ModelReference = {
  providerID: string
  modelID: string
}

export type ModelConfiguration = {
  harness: HarnessReference
  model: ModelReference
  /** Null means no explicit override; the wire field at the runtime is `variant`. */
  effort: string | null
}

/** Catalog identity of an installed plugin. Never a path and never a credential. */
export type PluginReference = {
  sourceId: string
  pluginName: string
}

/** Catalog identity of a skill, independent of the plugin that supplies it. */
export type SkillReference = {
  sourceId: string
  skillName: string
}

export type PresetExecution =
  | { placement: "local"; capabilities: { mode: "inherit-local" } }
  | {
      placement: "cloud"
      capabilities: { mode: "selected"; plugins: readonly PluginReference[]; skills: readonly SkillReference[] }
    }

export type PresetConfigurations = { primary: ModelConfiguration } & Partial<
  Record<Exclude<ConfigurationSlot, "primary">, ModelConfiguration>
>

export type Preset = {
  id: string
  revision: number
  scopeId: string
  ownerId: string
  name: string
  instructions: string
  execution: PresetExecution
  configurations: PresetConfigurations
  /**
   * Whether an agent inside a session may start this preset. False until a
   * person marks it in Settings: a session's Tasks grant reaches Start, and
   * without this a preset saved for the person's own use would be one every
   * agent in the project could put on a machine.
   */
  agentStartable: boolean
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

export type Task = {
  id: string
  revision: number
  scopeId: string
  projectId: string
  /**
   * The project-sequence number the task is filed under: its own for a root,
   * its parent's for a subtask. A root's number is minted by the store at
   * create and kept when it is archived, so one number names one root for as
   * long as the project exists and a person can quote it.
   */
  number: number
  /**
   * A subtask's place among its parent's children, minted when it is attached;
   * null on a root. With `number` it is the key a person quotes (`20.1`), and
   * both are minted again when the task is reparented or moved.
   */
  childNumber: number | null
  workspaceId: string | null
  parentTaskId: string | null
  /** The session whose agent created the task; null when a person created it in the app. */
  createdFrom: SessionReference | null
  title: string
  description: string
  status: TaskStatus
  childSetRevision: number
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}

/** The key a person quotes, without its project's letters: `20` for a root, `20.1` for its first subtask. */
export function taskNumber(task: Pick<Task, "number" | "childNumber">): string {
  return task.childNumber === null ? String(task.number) : `${task.number}.${task.childNumber}`
}

/**
 * What a list row may say about the task's sessions.
 *
 * A count and nothing more: liveness is read per session from the host that
 * runs it, which a list read does not do, and a row that guessed at it would
 * offer Open for a session that is gone.
 */
export type TaskLinkSummary = { count: number }

/**
 * How many subtasks the task has, and how many of those are done.
 *
 * Archived children count as neither: an archived subtask is not work the
 * parent still owes. Both numbers are the store's answer over every child the
 * task holds, not over the children a page happened to return — a row that
 * counted what the list read would report `0/1` for a parent whose only open
 * child fell outside the current filter.
 */
export type TaskChildSummary = { total: number; done: number }

/** An image a person attached at create. Bytes are read by their own route; a task read carries only this. */
export type TaskAttachment = {
  id: string
  filename: string
  mime: TaskAttachmentMime
  /** Decoded byte count, so a reader can size a fetch it has not made. */
  size: number
  createdAt: number
}

/** The stored row: the view plus the bytes, the keys that own it, and its place among the task's images. */
export type TaskAttachmentRecord = TaskAttachment & {
  scopeId: string
  taskId: string
  /** Zero-based, the order the person attached them in; one create shares one `createdAt`. */
  position: number
  bytes: Uint8Array
}

/** A list row. The description is omitted so a page cannot carry 50 × 64 KiB. */
export type TaskSummary = Omit<Task, "description"> & {
  hasDescription: boolean
  links: TaskLinkSummary
  children: TaskChildSummary
}

export type TaskSessionLink = {
  scopeId: string
  taskId: string
  slot: ConfigurationSlot
  attempt: number
  sessionRef: SessionReference
  continuedFrom: SessionReference | null
  presetId: string
  presetRevision: number
  presetNameAtStart: string
  /**
   * The configuration this session was created with, as `startConfigurationDigest`
   * renders it. A slot re-requested under a different configuration must not be
   * answered with this session, and the host reserves the origin under this
   * value, so the stored digest is compared rather than the request believed.
   */
  configurationDigest: string
  /**
   * The note the person starting the task wrote for this attempt, as the first
   * message carries it. Stored because the link commits before the message is
   * submitted: a handoff performed after a crash has no request to read it
   * from, and sending the task without it would hand over a different message.
   */
  handoffText: string | null
  /**
   * The session whose agent started this attempt, recorded by the host from
   * the grant it admitted and never from the request; null when a person
   * started it from the app. With `placement`, it is what a per-project cap
   * on agent-started cloud machines counts.
   */
  startedFrom: SessionReference | null
  /**
   * Who asked for this attempt: a person from the app, or a session's agent
   * through its grant. Recorded beside `startedFrom` because a grant minted
   * for a root rather than a session starts as an agent without a session to
   * name, and a cap on agent-started machines must still count it.
   */
  startedBy: SessionStarter
  placement: PresetPlacement
  createdAt: number
}

export const SESSION_STARTERS = ["person", "agent"] as const
export type SessionStarter = (typeof SESSION_STARTERS)[number]

export function isSessionStarter(value: unknown): value is SessionStarter {
  return typeof value === "string" && SESSION_STARTERS.some((starter) => starter === value)
}

export const SESSION_LIVENESS = ["live", "archived", "deleted", "unavailable"] as const
export type SessionLiveness = (typeof SESSION_LIVENESS)[number]

/**
 * Whether this attempt's first message reached its session, as the host's
 * history read answers it. `unknown` covers both a history the runtime would
 * not return and a session there is nothing to read, which are the same answer
 * to a reader: nobody can say, so nothing may be resent on the strength of it.
 */
export const SESSION_HANDOFF_STATES = ["sent", "pending", "unknown"] as const
export type SessionHandoffState = (typeof SESSION_HANDOFF_STATES)[number]

/**
 * A link as a task reader sees it. Preset provenance is the id, the revision
 * and the name recorded at start; private instructions and capability
 * selections never travel with a task.
 */
export type TaskSessionLinkView = {
  taskId: string
  slot: ConfigurationSlot
  attempt: number
  sessionRef: SessionReference
  continuedFrom: SessionReference | null
  presetId: string
  presetRevision: number
  presetNameAtStart: string
  createdAt: number
  liveness: SessionLiveness
  handoff: SessionHandoffState
}

export type InvalidFieldReason =
  | "required"
  | "type"
  | "too_long"
  | "too_many"
  | "duplicate"
  | "unknown_value"
  | "out_of_range"
  /** Well-formed and refused by a structural rule: a cycle, a grandchild, a locked field. */
  | "not_allowed"

export type InvalidField = {
  path: string
  reason: InvalidFieldReason
}

export type TasksErrorDetail = {
  code: TasksErrorCode
  message: string
  fields?: readonly InvalidField[]
  /** Carried with `stale_revision` so a client can rebase without a second read. */
  currentPreset?: Preset
  currentTask?: Task
}

export type TasksFailure = { ok: false; error: TasksErrorDetail }
export type TasksResult<T> = ({ ok: true } & T) | TasksFailure

export type PresetDraft = {
  name: string
  instructions: string
  execution: PresetExecution
  configurations: PresetConfigurations
  agentStartable: boolean
}

/** An image as a create carries it: standard base64 of the bytes, never a data URL and never a path. */
export type TaskAttachmentDraft = {
  filename: string
  mime: string
  data: string
}

export type TaskDraft = {
  projectId: string
  title: string
  description: string
  workspaceId: string | null
  parentTaskId: string | null
  /** Absent means To do, which is where a task that nobody parked belongs. */
  status?: TaskCreateStatus
  /** Sent by a session creating a task from inside itself; the app sends nothing. */
  createdFrom?: SessionReference
  /** Images stored with the task and handed to every session started on it. Absent means none. */
  attachments?: readonly TaskAttachmentDraft[]
}

export type PresetCreateInput = PresetDraft
export type PresetEditInput = PresetDraft & { presetId: string; revision: number }
export type PresetArchiveInput = { presetId: string; revision: number }
export type PresetRestoreInput = { presetId: string; revision: number }

export type TaskCreateInput = TaskDraft
export type TaskEditInput = {
  taskId: string
  revision: number
  title: string
  description: string
  workspaceId: string | null
}
export type TaskSetStatusInput = { taskId: string; revision: number; status: TaskStatus }
export type TaskReparentInput = {
  taskId: string
  revision: number
  parentTaskId: string | null
  projectId: string
}
export type TaskArchiveInput = { taskId: string; revision: number }
export type TaskRestoreInput = { taskId: string; revision: number }

export type TasksCommandInputByName = {
  "preset.create": PresetCreateInput
  "preset.edit": PresetEditInput
  "preset.archive": PresetArchiveInput
  "preset.restore": PresetRestoreInput
  "task.create": TaskCreateInput
  "task.edit": TaskEditInput
  "task.set_status": TaskSetStatusInput
  "task.reparent": TaskReparentInput
  "task.archive": TaskArchiveInput
  "task.restore": TaskRestoreInput
}

export const TASKS_COMMAND_NAMES = [
  "preset.create",
  "preset.edit",
  "preset.archive",
  "preset.restore",
  "task.create",
  "task.edit",
  "task.set_status",
  "task.reparent",
  "task.archive",
  "task.restore",
] as const
export type TasksCommandName = (typeof TASKS_COMMAND_NAMES)[number]

export type TasksCommand = {
  [Name in TasksCommandName]: { type: Name; input: TasksCommandInputByName[Name] }
}[TasksCommandName]

/**
 * A task mutation reports the parent it committed against, because a child
 * create, status change or archive bumps the parent's `childSetRevision` in
 * the same transaction and the caller's copy is stale the moment it returns.
 */
export type TaskCommandResult = { task: Task; parent: Task | null }

export type TasksCommandResultByName = {
  "preset.create": { preset: Preset }
  "preset.edit": { preset: Preset }
  "preset.archive": { preset: Preset }
  "preset.restore": { preset: Preset }
  "task.create": TaskCommandResult
  "task.edit": TaskCommandResult
  "task.set_status": TaskCommandResult
  "task.reparent": TaskCommandResult
  "task.archive": TaskCommandResult
  "task.restore": TaskCommandResult
}

export type TasksCommandResult = {
  [Name in TasksCommandName]: { type: Name } & TasksCommandResultByName[Name]
}[TasksCommandName]

export type TasksCommandRequest = {
  clientRequestId: string
  command: TasksCommand
}

export type TasksCommandResponse = {
  result: TasksCommandResult
  /** True when the receipt for this `clientRequestId` was replayed, not executed. */
  replayed: boolean
}

export type ListQuery = {
  cursor: string | null
  limit: number
}

export type PresetListQuery = ListQuery & {
  includeArchived: boolean
}

export type TaskListQuery = ListQuery & {
  projectId: string
  status: TaskStatus | null
  /** "root" lists only tasks without a parent; "any" lists children alongside them. */
  parent: "any" | "root"
  includeArchived: boolean
}

export type ChildListQuery = ListQuery & {
  includeArchived: boolean
}

export type Page<T> = {
  items: readonly T[]
  nextCursor: string | null
}

export type TasksCapabilities = {
  protocolVersion: number
  placements: readonly PresetPlacement[]
  /** Whether this host can honour a cloud preset's selected-only capability set. */
  cloudSelectedCapabilities: boolean
  configurationSlots: readonly ConfigurationSlot[]
  bounds: TasksBounds
}

export const START_BLOCKER_CODES = [
  "placement_unsupported",
  "harness_unavailable",
  "model_unavailable",
  "effort_unsupported",
  "capability_unavailable",
  "source_unavailable",
] as const
export type StartBlockerCode = (typeof START_BLOCKER_CODES)[number]

export type StartBlocker = {
  code: StartBlockerCode
  detail: string
}

export type StartPreviewRequest = {
  taskRevision: number
  presetId: string
  presetRevision: number
  slot: ConfigurationSlot
  attempt: number
  continueFromPrevious: boolean
  /** Sent by a session asking from inside itself; the app sends nothing. The host checks it before believing it. */
  startedFrom?: SessionReference
}

/**
 * The host's resolved answer for one (task, preset, slot, attempt). `digest`
 * and `expiresAt` are the host's own; Start revalidates them and a browser
 * copy is never treated as an access grant.
 */
export type StartPreview = {
  digest: string
  expiresAt: number
  placement: PresetPlacement
  slot: ConfigurationSlot
  attempt: number
  configuration: ModelConfiguration
  capabilities: PresetExecution["capabilities"]
  available: boolean
  blockers: readonly StartBlocker[]
  currentSession: { sessionRef: SessionReference; liveness: SessionLiveness } | null
  previousTranscriptReadable: boolean
  destinationDescription: string
}

export type StartPreviewResponse = {
  preview: StartPreview
}

export type StartRequest = {
  clientRequestId: string
  taskRevision: number
  presetId: string
  presetRevision: number
  slot: ConfigurationSlot
  attempt: number
  previewDigest: string
  handoffText: string | null
  continueFromPrevious: boolean
  /** Sent by a session asking from inside itself; the app sends nothing. The host checks it before believing it. */
  startedFrom?: SessionReference
}

export type StartResponse = {
  link: TaskSessionLinkView
  /** False when an existing live session or an already-stored link was returned. */
  created: boolean
}

export type TaskDetailResponse = {
  task: Task
  links: readonly TaskSessionLinkView[]
  attachments: readonly TaskAttachment[]
}
export type TaskChildrenResponse = Page<TaskSummary>

export function isConfigurationSlot(value: unknown): value is ConfigurationSlot {
  return typeof value === "string" && CONFIGURATION_SLOTS.some((slot) => slot === value)
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && TASK_STATUSES.some((status) => status === value)
}

export function isTaskCreateStatus(value: unknown): value is TaskCreateStatus {
  return typeof value === "string" && TASK_CREATE_STATUSES.some((status) => status === value)
}

export function isTaskAttachmentMime(value: unknown): value is TaskAttachmentMime {
  return typeof value === "string" && TASK_ATTACHMENT_MIMES.some((mime) => mime === value)
}

export function attachmentView(record: TaskAttachmentRecord): TaskAttachment {
  return { id: record.id, filename: record.filename, mime: record.mime, size: record.size, createdAt: record.createdAt }
}

export function isTasksCommandName(value: unknown): value is TasksCommandName {
  return typeof value === "string" && TASKS_COMMAND_NAMES.some((name) => name === value)
}

/** Both counts are required so a store cannot answer a list read without having counted. */
export function taskSummaryOf(task: Task, links: TaskLinkSummary, children: TaskChildSummary): TaskSummary {
  const { description, ...rest } = task
  return { ...rest, hasDescription: description.length > 0, links, children }
}

export function linkView(
  link: TaskSessionLink,
  liveness: SessionLiveness,
  handoff: SessionHandoffState,
): TaskSessionLinkView {
  return {
    taskId: link.taskId,
    slot: link.slot,
    attempt: link.attempt,
    sessionRef: link.sessionRef,
    continuedFrom: link.continuedFrom,
    presetId: link.presetId,
    presetRevision: link.presetRevision,
    presetNameAtStart: link.presetNameAtStart,
    createdAt: link.createdAt,
    liveness,
    handoff,
  }
}
