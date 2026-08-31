import type { AgentEventRuntime, RawHarnessEvent, RuntimeGoalSnapshot, SubagentUpdatedEvent } from "@claxedo/agent-event-runtime"
import type { GoalCapabilities } from "../../capabilities"
import type {
  AgentConfigOption,
  PromptInput,
  SessionConfig,
} from "../../index"
import type {
  AgentGoalResource,
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
  getAgentSessionId(sessionId: string): string | null | undefined
  getSessionConfig(sessionId: string): SessionConfig | null | undefined
  publishGoal(input: {
    sessionId: string
    directory: string
    goal: RuntimeGoalSnapshot | null
  }): void
  runProviderTurn(
    input: { sessionId: string; directory: string },
    execute: (turn: SdkRuntimeTurnInput) => Promise<void>,
  ): Promise<boolean>
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
  readonly goals?: AgentGoalResource
  readonly nativeGoal?: {
    capabilities(sessionId: string, directory: string): Promise<GoalCapabilities> | GoalCapabilities
    read(sessionId: string, directory: string): Promise<RuntimeGoalSnapshot | null>
    run(
      input: SdkRuntimeTurnInput,
      objective: string,
      onGoal: (goal: RuntimeGoalSnapshot | null) => void,
    ): Promise<void>
    stop(sessionId: string, directory: string): Promise<RuntimeGoalSnapshot | null>
    /**
     * Clear the Goal at the provider, for the drivers whose provider has such
     * an operation — only they may advertise the `delete` action.
     *
     * Optional because most native harnesses keep the Goal inside a provider
     * session with no clear operation at all: deleting locally would lie,
     * because resuming that session re-emits the Goal. `false` means the
     * provider had nothing to clear.
     */
    delete?(sessionId: string, directory: string): Promise<boolean>
  }
  setAuth(keys: SdkRuntimeAuth): void
  applyConfig(config: Record<string, unknown>): void | Promise<void>
  createAgentSession(input: { directory: string; title?: string; model: string; system?: string }): Promise<string>
  createRuntime(threadId: string): AgentEventRuntime
  runTurn(input: SdkRuntimeTurnInput): Promise<void>
  deleteAgentSession?(sessionId: string, agentSessionId: string, directory: string): void | Promise<void>
  dispose?(): void
  readRuntimeHealth(directory: string): AgentHarnessAdapterHealth
  configOptions(currentModel: string, directory?: string): Promise<AgentConfigOption[]>
  peekConfigOptions(currentModel: string, directory?: string): AgentConfigOption[]
  permissionModes?(sessionId: string, directory: string): AgentPermissionModeState
  setPermissionMode?(sessionId: string, modeId: string, directory: string): Promise<AgentPermissionModeState>
}

export type SdkRuntimeDriverFactory = (host: SdkRuntimeDriverHost) => SdkRuntimeDriver
