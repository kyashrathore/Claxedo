import type { CompatEvent } from "../../compat-events"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { AgentSession, AgentTurnOutcome, SessionConfig, SessionConfigUpdate } from "../../index"
import type { RuntimeAppendSource } from "./turn-projection"
import type { AdmittedSubagentObservation, SubagentObservation } from "../../subagent-admission"

export type AgentRuntimeSessionBinding = {
  sessionId: string
  directory: string
  title?: string
  agentSessionId: string
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
}

export type AgentRuntimeTurnFinishOutput = {
  /** Terminal events already committed by the authoritative store, in publish order. */
  events: CompatEvent[]
}

export type AgentRuntimeStoreCore = {
  listSessions(directory: string): unknown[]
  getSession(id: string): unknown | null
  bindSession(input: AgentRuntimeSessionBinding): void
  updateSessionConfig(id: string, update: SessionConfigUpdate): SessionConfig | null | undefined
  updateSession(id: string, updates: { title?: string; time?: { archived?: number } }): AgentSession | null
  getSessionConfig(id: string): SessionConfig | null | undefined
  deleteSession(id: string): void
  getAgentSessionId(id: string): string | null | undefined
  getGoal?(id: string): RuntimeGoalSnapshot | null | undefined
  setGoal?(id: string, goal: RuntimeGoalSnapshot | null): void
  acquireTurnLease(sessionId: string): string | undefined
  releaseTurnLease(sessionId: string, leaseId: string): void
  startTurn(input: unknown): AgentRuntimeTurnStartOutput
  finishTurn(input: AgentRuntimeTurnFinishInput): AgentRuntimeTurnFinishOutput
  appendEvent(input: {
    sessionId: string
    agentSessionId?: string
    payload: CompatEvent
    source?: RuntimeAppendSource
  }): AgentRuntimeCommittedCompatOutput
  getMessages(id: string): unknown[]
  getTodos(sessionId: string): Array<{ content: string; status: string; priority: string }>
  listPermissions(directory: string): Array<{ id: string; sessionID: string }>
  listQuestions(directory: string): Array<{ id: string; sessionID: string; questions: unknown[] }>
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

export type AgentRuntimeStore = AgentRuntimeStoreCore
export type AgentRuntimeStoreWithRecovery = AgentRuntimeStoreCore & AgentRuntimeRecoveryStore & AgentRuntimeOwnerStore
