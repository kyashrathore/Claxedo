export * from "./contracts"
export { TasksError, tasksErrorDetail, refuse, refuseInvalid, type FailureExtra } from "./errors"
export { hashRequest } from "./hash"
export { clampLimit, comparePageKeys, decodePageCursor, encodePageCursor, isAfterCursor, paginate, type PageKey } from "./paging"
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
  SessionStateReading,
  StartCommand,
  StartPreviewCommand,
  StartedSession,
  TasksSessionBridgePort,
} from "./ports/session-bridge"
export {
  joinedTransaction,
  type ChildCountFilter,
  type LinkInsertOutcome,
  type LinkStoreOperations,
  type PresetStoreOperations,
  type ReceiptStoreOperations,
  type TaskStoreOperations,
  type TasksCommandReceipt,
  type TasksStoreOperations,
  type TasksStorePort,
} from "./ports/store"

export { configurationEntries, draftHarnesses, validatePresetDraft, type HarnessLookup } from "./presets/model"
export { createPresetsService, type PresetsService, type PresetsServiceDeps } from "./presets/service"
export { validateReparent, validateTaskDraft, validateTaskEdit } from "./tasks/model"
export { createTasksService, type TaskMutation, type TasksService, type TasksServiceDeps } from "./tasks/service"
export { createTasksCommands, type TasksCommands, type TasksCommandsDeps } from "./commands"

export { createMemoryTasksStore } from "./stores/memory"
export {
  TASKS_STORE_CONFORMANCE_SCOPE,
  TASKS_STORE_CONFORMANCE_VERSION,
  tasksStoreConformance,
  type TasksStoreConformanceCase,
  type TasksStoreConformanceFactory,
} from "./conformance/store"
