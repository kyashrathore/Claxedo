/**
 * `@claxedo/opencode-runtime` — the sole owner of the public OpenCode
 * embedded SDK.
 *
 * Nothing outside this package may import `@opencode-ai/*` at runtime, hold a
 * URL, a raw router, a generic `fetch`, or the SDK constructor. Consumers get
 * the typed ports exported here.
 */
export {
  repairCoreLayerGraph,
  UpstreamShapeError,
  type RepairOutcome,
} from "./upstream-repair"
export {
  createOpenCodeHost,
  OpenCodeUnavailableError,
  type OpenCodeClient,
  type OpenCodeHost,
  type OpenCodeHostOptions,
} from "./host"
export {
  createEventPump,
  type EventPump,
  type EventPumpOptions,
  type ProjectedEvent,
} from "./event-pump"
export {
  canServe,
  isTerminal,
  type OpenCodeEventHealth,
  type OpenCodeLifecycle,
  type OpenCodeStatus,
} from "./lifecycle"
export {
  assertLocationInScope,
  authorizeWorkspace,
  sameScope,
  WorkspaceScopeError,
  type WorkspaceScope,
} from "./scope"
export {
  assertQuiesced,
  backupDatabase,
  digestFile,
  importPayloads,
  MigrationError,
  promote,
  sealManifest,
  validateAgainstManifest,
  type ImportedSession,
  type MigrationPhase,
  type TransferManifest,
} from "./migration"
export {
  expectationFor,
  toV2Transfer,
  TransferSchemaError,
  validateImported,
  type LegacyTransferEnvelope,
  type TransferExpectation,
  type TransferResult,
  type ValidationFailure,
} from "./transfer"
export {
  createSessionPort,
  type AdmittedMessage,
  type ForkBoundary,
  type MessagePage,
  type OpenCodeSessionPort,
  type PromptAttachment,
  type PromptRequest,
  type SessionMessage,
  type SessionPage,
  type SessionSummary,
} from "./session-port"
export {
  createCatalogPort,
  type AgentEntry,
  type CommandEntry,
  type ModelEntry,
  type OpenCodeCatalogPort,
} from "./catalog-port"
export {
  createInteractionPort,
  type FormFieldValue,
  type FormRequest,
  type OpenCodeInteractionPort,
  type PermissionReply,
  type PermissionRequest,
} from "./interaction-port"
