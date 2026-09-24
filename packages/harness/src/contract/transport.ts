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
import type { HarnessServices } from "./services"
import type { AttachInput, Deadline, HarnessSession, RoutedEvent, StartInput, TurnInput, TurnRef } from "./session"

export type TransportKind = "claude-sdk" | "codex-app-server" | "cursor-sdk" | "acp" | "pi-rpc" | "opencode-http"

export type TransportConfigUpdate = {
  credentials?: ResolvedCredentials
  projection?: PluginProjection
}

export type ConfigApplied =
  | { state: "applied" }
  | { state: "deferred"; until: "after-active-turns" | "next-session" }
  | { state: "refused"; reason: string }

export type ConfigTarget =
  | { session: HarnessSession }
  | { draft: { directory: string; model?: PromptModel } }

export type TransportHealth = {
  status: "ok" | "degraded" | "unavailable"
  reason?: string
  message?: string
}

export interface SteerOperations {
  steer(session: HarnessSession, turn: TurnRef, input: TurnInput): Promise<SteerResult>
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
  read(session: HarnessSession): Promise<SessionConfig>
  update(session: HarnessSession, update: SessionConfigUpdate): Promise<SessionConfig>
  options(target: ConfigTarget, mode: "probe" | "peek"): Promise<readonly AgentConfigOption[]>
  permissionModes(target: ConfigTarget): Promise<AgentPermissionModeState>
  setPermissionMode(session: HarnessSession, modeId: string): Promise<AgentPermissionModeState>
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
  list(directory: string): Promise<readonly AgentCommand[]>
}

export interface AgentListOperations {
  list(directory: string): Promise<readonly AgentAgent[]>
}

export interface ForkOperations {
  fork(session: HarnessSession, messageId: string, childSessionId?: string): Promise<{ upstreamSessionId: string }>
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
  send(session: HarnessSession, turn: TurnInput, broker: TurnBroker): AsyncIterable<RoutedEvent>
  cancel(session: HarnessSession, turn: TurnRef, deadline: Deadline): Promise<AdapterCancelOutcome>
  configure(update: TransportConfigUpdate): Promise<ConfigApplied>
  close(session: HarnessSession): Promise<void>
  dispose(): Promise<void>
  readonly steer?: SteerOperations
  readonly goals?: NativeGoalOperations
  readonly config?: ConfigOperations
  readonly history?: HistoryOperations
  readonly naming?: NamingOperations
  readonly commands?: CommandOperations
  readonly agents?: AgentListOperations
  readonly fork?: ForkOperations
  readonly health?: HealthOperations
}

export type TransportFactory<Config> = (input: { config: Config; services: HarnessServices }) => HarnessTransport
