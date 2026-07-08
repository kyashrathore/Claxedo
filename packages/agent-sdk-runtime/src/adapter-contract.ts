import type { CompatEvent } from "./compat-events"
import type { StatusChunk } from "./status"
import type { AdapterCapability, HarnessCapabilityContext, HarnessCapabilities } from "./capabilities"
import type {
  AgentAgent,
  AgentCommand,
  AgentConfigOption,
  AgentMessage,
  AgentPermission,
  AgentQuestion,
  AgentRuntimeStreamEvent,
  AgentSession,
  PromptInput,
  RuntimeDirectory,
  SessionConfig,
  SessionConfigUpdate,
} from "./index"

export type AbortResult =
  | { ok: true; status: "cancelled" | "already_idle" }
  | { ok: false; status: "not_found" | "recovering" | "failed"; message: string }

export type AgentHarnessAdapterHealth = {
  status: "ok" | "degraded" | "unavailable"
  reason?: string
  message?: string
  sessions?: Array<{
    id: string
    status?: string | null
    message?: string | null
  }>
}

export type PermissionDecision = "allow_once" | "allow_always" | "deny" | "reject_always"

export type AgentInteractionResult = {
  events: CompatEvent[]
}

export interface AgentHarnessAdapterCore {
  readonly adapterCapabilities?: readonly AdapterCapability[]

  listSessions(directory: RuntimeDirectory): Promise<AgentSession[]>
  getSession(id: string, directory: RuntimeDirectory): Promise<AgentSession | null>
  createSession(directory: RuntimeDirectory, title?: string): Promise<{ id: string }>
  updateSession(id: string, updates: { title?: string; time?: { archived?: number } }, directory: RuntimeDirectory): Promise<AgentSession | null>
  getSessionConfig(id: string, directory: RuntimeDirectory): Promise<SessionConfig>
  updateSessionConfig(id: string, update: SessionConfigUpdate, directory: RuntimeDirectory): Promise<SessionConfig>
  deleteSession(id: string, directory: RuntimeDirectory): Promise<void>

  readHarnessCapabilities(directory: RuntimeDirectory, context?: HarnessCapabilityContext): Promise<HarnessCapabilities> | HarnessCapabilities

  sendMessage(id: string, input: PromptInput, directory: RuntimeDirectory): AsyncIterable<AgentRuntimeStreamEvent>
  getMessages(id: string, directory: RuntimeDirectory): Promise<AgentMessage[]>

  listCommands?(directory: RuntimeDirectory): Promise<AgentCommand[]>
  readRuntimeHealth?(directory: RuntimeDirectory): AgentHarnessAdapterHealth

  dispose(): void
}

export interface SupportsAbort {
  abort(id: string, directory: RuntimeDirectory): Promise<AbortResult>
}

export interface SupportsRevert {
  revert(id: string, directory: RuntimeDirectory): Promise<void>
}

export interface SupportsUnrevert {
  unrevert(id: string, directory: RuntimeDirectory): Promise<void>
}

export interface SupportsFork {
  forkSession(id: string, messageId: string, directory: RuntimeDirectory): Promise<{ id: string }>
}

export interface SupportsCommands {
  executeCommand(id: string, command: string, directory: RuntimeDirectory): Promise<void>
}

export interface SupportsAgents {
  listAgents(directory: RuntimeDirectory): Promise<AgentAgent[]>
}

export interface SupportsTodos {
  getTodos(sessionId: string, directory: RuntimeDirectory): Promise<Array<{ content: string; status: string; priority: string }>>
}

export interface SupportsPermissions {
  listPermissions(directory: RuntimeDirectory): Promise<AgentPermission[]>
  respondPermission(permId: string, decision: PermissionDecision, directory: RuntimeDirectory): Promise<AgentInteractionResult | void>
}

export interface SupportsQuestions {
  listQuestions(directory: RuntimeDirectory): Promise<AgentQuestion[]>
  replyQuestion(qId: string, answer: string, directory: RuntimeDirectory): Promise<AgentInteractionResult | void>
  rejectQuestion(qId: string, directory: RuntimeDirectory): Promise<AgentInteractionResult | void>
}

export interface SupportsRuntimeConfig {
  applyConfig(config: Record<string, unknown>): Promise<void>
}

export interface SupportsConfigOptions {
  probeConfigOptions(directory: RuntimeDirectory): Promise<AgentConfigOption[]>
  peekConfigOptions?(directory: RuntimeDirectory): Promise<AgentConfigOption[] | null> | AgentConfigOption[] | null
}

export type AgentHarnessAdapter =
  & AgentHarnessAdapterCore
  & Partial<SupportsAbort>
  & Partial<SupportsRevert>
  & Partial<SupportsUnrevert>
  & Partial<SupportsFork>
  & Partial<SupportsCommands>
  & Partial<SupportsAgents>
  & Partial<SupportsTodos>
  & Partial<SupportsPermissions>
  & Partial<SupportsQuestions>
  & Partial<SupportsRuntimeConfig>
  & Partial<SupportsConfigOptions>

export type AgentRuntimeStatusChunk = StatusChunk
