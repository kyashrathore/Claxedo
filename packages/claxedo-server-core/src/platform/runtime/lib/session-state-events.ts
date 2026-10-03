import type { AgentTurnOutcome, SessionAttentionEvent, SessionAttentionFacts, SessionReaderState } from "@claxedo/agent-runtime-contract"
import { parseAgentTurnOutcome, parseBackgroundWork, parseSessionAttention, parseSessionReader } from "@claxedo/agent-runtime-contract"
import type { SessionRowStatus } from "../../../session/navigation-list"
import { jsonRecord } from "./json"

type SessionNoticeRef = {
  ownerUserId?: string
  orgId?: string
  sessionId: string
  workspaceId: string
  projectId: string
  ts: number
  replayed?: boolean
}
export type SessionStatusChangedEvent = SessionNoticeRef & {
  type: "session.status.changed"
  title?: string
  attention: SessionAttentionFacts
  lastTurn?: AgentTurnOutcome
  status: SessionRowStatus
}
export type SessionAttentionRaisedEvent = SessionNoticeRef & {
  type: "session.attention.raised"
  title?: string
  generation: number
  event: SessionAttentionEvent
}
export type SessionReaderChangedEvent = SessionNoticeRef & {
  type: "session.reader.changed"
  reader: SessionReaderState
}
export type SessionRemovedEvent = SessionNoticeRef & { type: "session.removed" }
export type SessionStateEvent = SessionStatusChangedEvent | SessionAttentionRaisedEvent | SessionReaderChangedEvent | SessionRemovedEvent

export function parseSessionStateEvent(input: unknown): SessionStateEvent | undefined {
  const row = jsonRecord(input)
  if (!row || typeof row.sessionId !== "string" || typeof row.workspaceId !== "string"
    || typeof row.projectId !== "string" || typeof row.ts !== "number" || !Number.isSafeInteger(row.ts) || row.ts < 0
    || (row.ownerUserId !== undefined && typeof row.ownerUserId !== "string")
    || (row.orgId !== undefined && typeof row.orgId !== "string")
    || (row.replayed !== undefined && typeof row.replayed !== "boolean")) return undefined
  const base = { sessionId: row.sessionId, workspaceId: row.workspaceId, projectId: row.projectId,
    ts: row.ts, ...(row.ownerUserId ? { ownerUserId: row.ownerUserId } : {}),
    ...(row.orgId ? { orgId: row.orgId } : {}),
    ...(row.replayed !== undefined ? { replayed: row.replayed } : {}) }
  try {
    if (row.type === "session.removed") return { ...base, type: row.type }
    if (row.type === "session.reader.changed") {
      const reader = parseSessionReader(row.reader)
      return reader ? { ...base, type: row.type, reader } : undefined
    }
    const title = typeof row.title === "string" ? { title: row.title } : {}
    if (row.type === "session.status.changed") {
      const attention = parseSessionAttention(row.attention)
      const backgroundWork = parseBackgroundWork(jsonRecord(row.status)?.backgroundWork)
      const status = jsonRecord(row.status)
      if (!attention || !status || (status.kind !== "idle" && status.kind !== "busy" && status.kind !== "retry" && status.kind !== "interrupted")
        || typeof status.awaitingInput !== "boolean" || typeof status.at !== "number" || !Number.isSafeInteger(status.at) || status.at < 0) return undefined
      const lastTurn = parseAgentTurnOutcome(row.lastTurn)
      return { ...base, ...title, type: row.type, attention, ...(lastTurn ? { lastTurn } : {}),
        status: { kind: status.kind, awaitingInput: status.awaitingInput, at: status.at,
          ...(backgroundWork ? { backgroundWork } : {}) } }
    }
    if (row.type !== "session.attention.raised" || typeof row.generation !== "number" || !Number.isSafeInteger(row.generation) || row.generation < 0) return undefined
    const event = jsonRecord(row.event)
    if (!event || typeof event.sequence !== "number" || !Number.isSafeInteger(event.sequence) || event.sequence <= row.generation
      || typeof event.openedAt !== "number" || !Number.isSafeInteger(event.openedAt) || event.openedAt < 0) return undefined
    const raised = { sequence: event.sequence, openedAt: event.openedAt }
    if (event.kind === "outcome" && (event.outcome === "completed" || event.outcome === "failed" || event.outcome === "cancelled")) {
      return { ...base, ...title, type: row.type, generation: row.generation,
        event: { ...raised, kind: "outcome", outcome: event.outcome } }
    }
    if ((event.kind === "question" || event.kind === "permission") && typeof event.requestId === "string" && event.requestId) {
      return { ...base, ...title, type: row.type, generation: row.generation,
        event: { ...raised, kind: event.kind, requestId: event.requestId } }
    }
    return undefined
  } catch {
    return undefined
  }
}
