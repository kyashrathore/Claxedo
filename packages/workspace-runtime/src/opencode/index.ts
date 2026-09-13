/** Public OpenCode integration owned by workspace-runtime. */
export {
  createOpenCodeHost,
  OpenCodeUnavailableError,
  type OpenCodeClient,
  type OpenCodeHost,
  type OpenCodeHostOptions,
} from "./host"
export { createEventPump, type EventPump, type EventPumpOptions, type ProjectedEvent } from "./event-pump"
export {
  canServe,
  isTerminal,
  type OpenCodeEventHealth,
  type OpenCodeLifecycle,
  type OpenCodeStatus,
} from "./lifecycle"
export { assertLocationInScope, WorkspaceScope, sameScope, WorkspaceScopeError } from "./scope"
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
export {
  createToolPort,
  type OpenCodeToolPort,
  type SessionTool,
  type SessionToolRegistration,
} from "./tool-port"
export { createOpenCodeRuntime, type OpenCodeRuntime } from "./runtime"
export {
  createConfigurationPort,
  type IntegrationConnection,
  type IntegrationEntry,
  type OpenCodeConfigurationPort,
} from "./configuration-port"
export { OpenCodeSdkHarnessAdapter } from "./harness-adapter"
export { createLaunchPolicy, type LaunchPolicyStore, type OpenCodeLaunchDocument } from "./launch-policy"
export { createProviderBindingPolicy, type ProviderBindingOverlay } from "./provider-binding"
