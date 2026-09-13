export * from "./contracts"
export { TasksError, tasksErrorDetail, refuse, refuseInvalid } from "./errors"
export { hashRequest } from "./hash"
export { clampLimit, decodePageCursor, encodePageCursor, paginate, type PageKey } from "./paging"
export { type Parsed } from "./validation"
export {
  decodeCapabilitiesResponse,
  decodeCommandResponse,
  decodePreset,
  decodePresetPage,
  decodeStartPreviewResponse,
  decodeStartResponse,
  decodeTask,
  decodeTaskDetail,
  decodeTaskSummaryPage,
} from "./decode"

export type { TasksAuthorizationPort } from "./ports/authorization"
export type { HarnessDescriptor, TasksCapabilitiesPort, TasksHostCapabilities } from "./ports/capabilities"
export type { TasksClockPort } from "./ports/clock"
export type { TasksIdsPort } from "./ports/ids"
export type {
  SessionAbandonCommand,
  SessionHandoffCommand,
  SessionOrigin,
  SessionStateReading,
  StartCommand,
  StartPreviewCommand,
  StartedSession,
  TasksSessionBridgePort,
  TranscriptGrant,
} from "./ports/session-bridge"
export {
  TASKS_STORE_CONFLICTS,
  TasksStoreConflict,
  joinedTransaction,
  serializedTransactions,
  type ChildCountFilter,
  type LinkInsertOutcome,
  type LinkStoreOperations,
  type PresetStoreOperations,
  type ReceiptStoreOperations,
  type TaskStoreOperations,
  type TasksCommandReceipt,
  type TasksStoreConflictKind,
  type TasksStoreOperations,
  type TasksStorePort,
} from "./ports/store"

export { configurationEntries, draftHarnesses, validatePresetDraft, type HarnessLookup } from "./presets/model"
export { createPresetsService, type PresetsService, type PresetsServiceDeps } from "./presets/service"
export { validateReparent, validateTaskDraft, validateTaskEdit } from "./tasks/model"
export { createTasksService, type TasksService, type TasksServiceDeps } from "./tasks/service"
export { createTasksCommands, type TasksCommands, type TasksCommandsDeps } from "./commands"

export {
  START_ORIGIN_PREFIX,
  startConfigurationDigest,
  startDigest,
  startFirstMessage,
  startInstructions,
  startModelGroup,
  startOriginId,
  type StartDigestInput,
  type StartFirstMessageInput,
  type StartInstructions,
  type StartInstructionsInput,
  type StartModelGroup,
  type StartModelGroupEntry,
} from "./start"
