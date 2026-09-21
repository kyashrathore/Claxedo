import type { CompatEvent, CompatPromptFormat } from "../../compat-events"
import type {
  AgentExecutionBinding,
  AgentMessage,
  AgentPermission,
  AgentQuestion,
  AgentTodo,
} from "@claxedo/agent-runtime-contract"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { AgentSession, AgentTurnOutcome, PromptInput, SessionConfig, SessionConfigUpdate } from "../../index"
import type { RuntimeAppendSource } from "./turn-projection"
import type { AdmittedSubagentObservation, SubagentObservation } from "../../subagent-admission"

export class AgentRuntimeStaleTurnError extends Error {
  readonly code = "session_turn_fence_stale"

  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} rejected a stale turn generation`)
    this.name = "AgentRuntimeStaleTurnError"
  }
}

/**
 * A session as `listSessions` presents it: the canonical session plus the
 * snake_case projection the stores put on a list row (and the config a
 * persistent store projects there). Readers of those fields are stating what
 * the store already returns rather than re-describing the row.
 */
export type AgentRuntimeSessionRow = AgentSession & {
  slug?: string
  created_at?: number
  archived_at?: number | null
  recovery_error?: string | null
  agent_session_id?: string | null
  config?: SessionConfig
}

export type AgentRuntimeSessionBinding = {
  scope?: "workspace"
  sessionId: string
  directory: string
  title?: string
  agentSessionId: string
  workspaceId?: string
  connectionId?: string
  upstreamSessionId?: string
  ownerKey?: string | null
  parentSessionId?: string
}

export type AgentRuntimeCommittedCompatOutput = {
  sessionId: string
  seq: number
  createdAt: number
  agentSessionId?: string
  payload: CompatEvent
  source?: RuntimeAppendSource
}

/** The one description of a turn start; both stores and every caller use it. */
export type AgentRuntimeTurnStartInput = {
  sessionId: string
  agentSessionId?: string
  userMessageId?: string
  parentMessageId?: string
  assistantMessageId: string
  agent: string
  model?: { providerID: string; modelID: string }
  parts: PromptInput["parts"]
  tools?: Record<string, boolean>
  format?: CompatPromptFormat
  system?: string
  variant?: string
  actorId?: string
  actorKind?: "human" | "agent"
  author?: PromptInput["author"]
  fencingToken?: number
}

/** The one description of a committed compat event append. */
export type AgentRuntimeAppendEventInput = {
  sessionId: string
  agentSessionId?: string
  payload: CompatEvent
  source?: RuntimeAppendSource
  fencingToken?: number
}

export type AgentRuntimeTurnStartOutput = {
  sessionId: string
  seq: number
  createdAt: number
  agentSessionId?: string
  events: CompatEvent[]
}

export type AgentRuntimeTurnFinishInput = {
  sessionId: string
  assistantMessageId?: string
  outcome: AgentTurnOutcome
  fencingToken?: number
}

export type AgentRuntimeTurnFinishOutput = {
  /** Terminal events already committed by the authoritative store, in publish order. */
  events: CompatEvent[]
}

export type AgentRuntimeStoreCore = {
  sessionStarts?: import("@claxedo/agent-runtime-contract").AgentSessionStarts
  listSessions(directory: string): AgentRuntimeSessionRow[]
  getSession(id: string): AgentSession | null | undefined
  bindSession(input: AgentRuntimeSessionBinding): void
  updateSessionConfig(id: string, update: SessionConfigUpdate): SessionConfig | null | undefined
  updateSession(id: string, updates: { title?: string; time?: { archived?: number } }): AgentSession | null
  getSessionConfig(id: string): SessionConfig | null | undefined
  deleteSession(id: string): void
  getAgentSessionId(id: string): string | null | undefined
  getExecutionBinding(id: string): AgentExecutionBinding | null | undefined
  getGoal?(id: string): RuntimeGoalSnapshot | null | undefined
  setGoal?(id: string, goal: RuntimeGoalSnapshot | null): void
  acquireTurnLease(sessionId: string): string | undefined
  releaseTurnLease(sessionId: string, leaseId: string): void
  startTurn(input: AgentRuntimeTurnStartInput): AgentRuntimeTurnStartOutput
  finishTurn(input: AgentRuntimeTurnFinishInput): AgentRuntimeTurnFinishOutput
  appendEvent(input: AgentRuntimeAppendEventInput): AgentRuntimeCommittedCompatOutput
  getMessages(id: string): AgentMessage[]
  getLatestUserMessageId(id: string): string | undefined
  getTodos(sessionId: string): AgentTodo[]
  listPermissions(directory: string): AgentPermission[]
  listQuestions(directory: string): AgentQuestion[]
  listSubagents?(parentSessionId: string): unknown[]
  stalePermission(id: string): void
  admit?(input: {
    parentSessionId: string
    observation: SubagentObservation
    allocateKey: () => string
    allocateChildSessionId?: () => string
  }): AdmittedSubagentObservation
  markPublished?(parentSessionId: string, observationId: string): void
  close?: () => void
}

export type AgentRuntimeRecoveryStore = {
  markRecovering(sessionId: string, message?: string): void
  markSessionInterrupted(sessionId: string, message?: string, agentSessionId?: string | null): void
  consumeRecoveryError(sessionId: string): string | null | undefined
}

export type AgentRuntimeOwnerStore = {
  markSessionsInterruptedByOwner?(ownerKey: string, message?: string): void
  getSessionOwnerKey?(id: string): string | null | undefined
  listSessionsByOwnerKey?(ownerKey: string): string[]
}

export type AgentRuntimeStoreWithRecovery = AgentRuntimeStoreCore & AgentRuntimeRecoveryStore & AgentRuntimeOwnerStore
