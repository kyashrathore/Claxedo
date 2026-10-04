import type {
  AdapterCancelOutcome,
  AgentAgent,
  AgentCommand,
  AgentConfigOption,
  AgentGoalMutationResult,
  AgentMessage,
  AgentPermissionModeState,
  AgentTodo,
  ConnectionRuntimeStatus,
  PromptModel,
  RuntimeGoalSnapshot,
  SessionConfig,
  SessionConfigUpdate,
  SessionTitleRequest,
  SteerResult,
} from "@claxedo/agent-runtime-contract"
import type { SessionBroker, TurnBroker } from "./broker"
import type { CapabilityContext, TransportCapabilities } from "./capabilities"
import type { PluginProjection, ResolvedCredentials } from "./projection"
import type { CustomProviderDefinition, ProviderCatalogEntry } from "./provider-definitions"
import type { AttachInput, Deadline, HarnessSession, RoutedEvent, StartInput, TurnInput, TurnRef } from "./session"

export type TransportKind = "claude-sdk" | "codex-app-server" | "cursor-sdk" | "acp" | "pi-durable" | "opencode-sdk"

export type TransportConfigUpdate = {
  providerDefinitions?: readonly CustomProviderDefinition[]
  credentials?: ResolvedCredentials
  projection?: PluginProjection
}

export type ConfigApplied =
  | { state: "applied" }
  | { state: "deferred"; until: "after-active-turns" | "next-session" }
  | { state: "refused"; reason: string }

export type DraftLaunch = Omit<StartInput, "sessionId" | "title" | "instructions" | "permissionModeKept">

export type ConfigTarget = { session: HarnessSession } | { draft: DraftLaunch }

export type ConfigPreviewTarget = { session: HarnessSession; model?: PromptModel } | { draft: DraftLaunch }

export type ConfigOptionsPreview = {
  options: readonly AgentConfigOption[]
  resolvedModel?: { id: string; name: string }
}

export type TransportHealth = {
  status: "ok" | "degraded" | "unavailable"
  reason?: string
  message?: string
}

export interface SteerOperations {
  steer(session: HarnessSession, turn: TurnRef, input: TurnInput): Promise<SteerResult>
}

export type BackgroundTaskRef = { toolCallId: string }

export type BackgroundTaskStopResult = { ok: true } | { ok: false; status: "not_found"; message: string }

export interface BackgroundTaskOperations {
  stop(session: HarnessSession, task: BackgroundTaskRef): Promise<BackgroundTaskStopResult>
}

export interface NativeGoalOperations {
  read(session: HarnessSession): Promise<RuntimeGoalSnapshot | null>
  start(session: HarnessSession, objective: string, broker: SessionBroker): Promise<AgentGoalMutationResult>
  pause(session: HarnessSession): Promise<AgentGoalMutationResult>
  resume(session: HarnessSession, broker: SessionBroker): Promise<AgentGoalMutationResult>
  stop(session: HarnessSession): Promise<AgentGoalMutationResult>
  delete(session: HarnessSession): Promise<AgentGoalMutationResult<null>>
}

export interface ConfigOperations {
  options(target: ConfigPreviewTarget, mode: "probe" | "peek"): Promise<ConfigOptionsPreview>
  permissionModes(target: ConfigTarget): Promise<AgentPermissionModeState>
  setPermissionMode(session: HarnessSession, modeId: string): Promise<AgentPermissionModeState>
  setModelSettings?(session: HarnessSession, settings: ModelSettings): Promise<void>
}

export type ModelSettings = { model?: PromptModel; effort?: string | null }

export interface HarnessConfigOperations {
  read(session: HarnessSession): Promise<SessionConfig>
  update(session: HarnessSession, update: SessionConfigUpdate): Promise<SessionConfig>
}

export interface HistoryOperations {
  messages(session: HarnessSession): Promise<readonly AgentMessage[]>
  todos(session: HarnessSession): Promise<readonly AgentTodo[]>
}

export interface NamingOperations {
  generateTitle?(session: HarnessSession, request: SessionTitleRequest): Promise<string | null>
  rename?(session: HarnessSession, title: string): Promise<void>
}

export interface CommandOperations {
  list(target: ConfigTarget): Promise<readonly AgentCommand[]>
}

export interface AgentListOperations {
  list(target: ConfigTarget): Promise<readonly AgentAgent[]>
}

export interface ForkOperations {
  fork(session: HarnessSession, messageId: string, childSessionId: string): Promise<{ upstreamSessionId: string }>
}

export type SessionTool = Readonly<{
  name: string
  description: string
  inputSchema: Readonly<Record<string, unknown>>
  outputSchema?: Readonly<Record<string, unknown>>
}>

export type SessionToolCall = Readonly<{ name: string; toolCallID: string; input: unknown }>

export type ScopedSessionTools = { tools: readonly SessionTool[]; execute(call: SessionToolCall): Promise<unknown> }

export interface SessionToolOperations {
  register(session: HarnessSession, tools: ScopedSessionTools): Promise<void>
  unregister(session: HarnessSession): Promise<void>
}

export interface HealthOperations {
  connection(directory: string, sessionId?: string): ConnectionRuntimeStatus
  runtime(directory: string, sessionId?: string): TransportHealth
}

export interface HarnessTransport {
  readonly kind: TransportKind
  capabilities(context: CapabilityContext): Promise<TransportCapabilities>
  start(input: StartInput, session: SessionBroker): Promise<HarnessSession>
  attach(input: AttachInput, session: SessionBroker): Promise<HarnessSession>
  restore?(session: HarnessSession): Promise<HarnessSession>
  send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent>
  cancel(session: HarnessSession, turn: TurnRef, deadline: Deadline): Promise<AdapterCancelOutcome>
  configure(session: HarnessSession, update: TransportConfigUpdate): Promise<ConfigApplied>
  close(session: HarnessSession): Promise<void>
  dispose(): Promise<void>
  readonly steer?: SteerOperations
  readonly backgroundTasks?: BackgroundTaskOperations
  readonly goals?: NativeGoalOperations
  readonly providerCatalog?: { providers(draft: DraftLaunch): Promise<readonly ProviderCatalogEntry[]> }
  readonly config?: ConfigOperations
  readonly harnessConfig?: HarnessConfigOperations
  readonly history?: HistoryOperations
  readonly naming?: NamingOperations
  readonly commands?: CommandOperations
  readonly agents?: AgentListOperations
  readonly fork?: ForkOperations
  readonly health?: HealthOperations
  readonly sessionTools?: SessionToolOperations
}
