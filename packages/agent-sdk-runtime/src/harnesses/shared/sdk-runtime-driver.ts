import type { AgentEventRuntime, RawHarnessEvent, SubagentUpdatedEvent } from "@claxedo/agent-event-runtime"
import type {
  AgentConfigOption,
  PromptInput,
} from "../../index"
import type {
  AgentHarnessAdapterHealth,
  AgentHarnessAdapterProcessOptions,
  AgentPermissionModeState,
} from "../../adapter-contract"
import type { RuntimeEventHub } from "../../runtime-event-hub"
import type { NativeSdkHarnessId } from "../../sdk-model-catalog"
import type { AgentProcessObserver } from "../../process-observer"
import type { SubagentObservation } from "../../subagent-admission"
import type { RuntimeEventRoute, ChildProjectionTarget } from "./child-event-routing"
import type { AgentRuntimeStore } from "./runtime-store"
import type { RuntimeAppendSource } from "./turn-projection"
import type { SessionTurnLifecycle } from "./turn-lifecycle"

export type SdkRuntimeRunnerType = NativeSdkHarnessId
export type SdkRuntimeStore = AgentRuntimeStore
export type JsonRecord = Record<string, unknown>

export type SdkRuntimeTranscriptRegistrar = {
  register(input: { parentSessionId: string; providerKind: string; filePath: string }): Promise<
    | { state: "ready"; handle: string }
    | { state: "unavailable"; reason: string }
  >
  open?(input: { parentSessionId: string; handle: string }): Promise<
    | { state: "ready"; messages: unknown[] }
    | { state: "empty"; messages: [] }
    | { state: "unavailable"; reason: string }
  >
}

export type SdkRuntimeAdapterOptions = AgentHarnessAdapterProcessOptions & {
  driver: SdkRuntimeDriverFactory
  binary?: string
  storeRoot?: string
  store?: SdkRuntimeStore
  createStore?: (storeRoot?: string) => SdkRuntimeStore
  eventHub?: RuntimeEventHub
  transcriptRegistrar?: SdkRuntimeTranscriptRegistrar
}

export type PendingPermission = {
  sessionId: string
  agentSessionId: string
  method: string
  params: JsonRecord
  resolve: (decision: "allow_once" | "allow_always" | "deny" | "reject_always") => void
}

export type PendingQuestion = {
  sessionId: string
  agentSessionId: string
  questions: unknown[]
  resolve: (answer: string) => void
  reject: () => void
}

export type ActiveTurn = {
  abort: AbortController
  close?: () => void
  turnId?: string
}

export type SdkRuntimeAuth = { anthropic?: string; openai?: string; cursor?: string }

export type SdkRuntimeDriverHost = {
  lifecycle: () => SessionTurnLifecycle<ActiveTurn>
  pendingPermissions: Map<string, PendingPermission>
  pendingQuestions: Map<string, PendingQuestion>
  processObserver?: AgentProcessObserver
  transcriptRegistrar?: SdkRuntimeTranscriptRegistrar
  bindSession(input: { sessionId: string; directory: string; title?: string; agentSessionId: string }): void
}

export type SdkRuntimeTurnInput = {
  sessionId: string
  getAgentSessionId: () => string
  input: PromptInput
  directory: string
  abort: AbortController
  ingest: (raw: RawHarnessEvent, source: RuntimeAppendSource, route?: RuntimeEventRoute) => void
  associateChild: (correlationKey: string, target: ChildProjectionTarget) => void
  observeSubagent: (input: {
    observation: SubagentObservation
    correlationKeys?: string[]
    source?: RuntimeAppendSource
  }) => Promise<{ event: SubagentUpdatedEvent; childSessionId?: string }>
  rebindAgentSession: (agentSessionId: string) => void
  model: string
}

export type SdkRuntimeDriver = {
  readonly type: SdkRuntimeRunnerType
  setAuth(keys: SdkRuntimeAuth): void
  applyConfig(config: Record<string, unknown>): void | Promise<void>
  createAgentSession(input: { directory: string; title?: string; model: string; system?: string }): Promise<string>
  createRuntime(threadId: string): AgentEventRuntime
  runTurn(input: SdkRuntimeTurnInput): Promise<void>
  deleteAgentSession(sessionId: string, agentSessionId: string, directory: string): void | Promise<void>
  dispose?(): void
  readRuntimeHealth(directory: string): AgentHarnessAdapterHealth
  configOptions(currentModel: string, directory?: string): Promise<AgentConfigOption[]>
  peekConfigOptions(currentModel: string, directory?: string): AgentConfigOption[]
  /** Omit these methods when the harness has no permission-mode surface. */
  permissionModes?(sessionId: string, directory: string): AgentPermissionModeState
  setPermissionMode?(sessionId: string, modeId: string, directory: string): Promise<AgentPermissionModeState>
}

export type SdkRuntimeDriverFactory = (host: SdkRuntimeDriverHost) => SdkRuntimeDriver
