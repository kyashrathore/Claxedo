import type {
  AgentExecutionBinding,
  AgentTodo,
  PromptInput,
  PromptModel,
  SessionConfig,
} from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime/contracts"
import type { PluginProjection, ResolvedCredentials } from "./projection"

export type Locality = "local" | "remote"

export type TurnActor = { kind: "machine-owner" } | { kind: "person"; userId: string }

export type TurnOrigin = {
  actor: TurnActor
  via: "loopback" | "owner-grant" | "relay" | "service"
  reissued: boolean
}

export type HarnessBinding = AgentExecutionBinding

export type HarnessSession = {
  binding: HarnessBinding
  directory: string
  locality: Locality
}

export type StartInput = {
  sessionId: string
  directory: string
  locality: Locality
  title?: string
  model?: PromptModel
  config: SessionConfig
  instructions?: string
  projection: PluginProjection
  credentials: ResolvedCredentials
  owner: TurnActor
}

export type AttachInput = Omit<StartInput, "title" | "instructions"> & {
  binding: HarnessBinding
}

export type TurnInput = {
  turnId: string
  userMessageId: string
  assistantMessageId: string
  prompt: PromptInput
  model?: PromptModel
  effort?: string | null
  system?: string
  todos: readonly AgentTodo[]
  origin: TurnOrigin
}

export type TurnRef = {
  turnId: string
  assistantMessageId: string
}

export type Deadline = {
  at: number
  signal: AbortSignal
}

export type EventRoute = { kind: "parent" } | { kind: "child"; correlationKey?: string }

export type EventSource = {
  dir: "in" | "out"
  method: string
  requestId?: string
}

export type RoutedEvent = {
  event: AgentRuntimeEvent
  route?: EventRoute
  source?: EventSource
}
