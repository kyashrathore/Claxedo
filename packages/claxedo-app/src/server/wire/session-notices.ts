import { parseAgentTurnOutcome, parseSessionAttention, parseSessionReader, type SessionAttentionEvent } from "@claxedo/agent-runtime-contract"
import { asRecord, nonEmptyString } from "@claxedo/helpers/guards"
import type { ServerEvent } from "../events"
import { contractMismatch } from "../errors"
import { placementId, projectId, sessionId } from "../ids"
import type { Frame } from "./frames"
import type { Address } from "./session-row"

function positivePosition(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function parseNoticeAttentionEvent(value: unknown): SessionAttentionEvent | undefined {
  const event = asRecord(value)
  if (!event || !positivePosition(event.sequence) || typeof event.openedAt !== "number" || !Number.isSafeInteger(event.openedAt) || event.openedAt < 0) return undefined
  if (event.kind === "outcome" && (event.outcome === "completed" || event.outcome === "failed" || event.outcome === "cancelled")) {
    return { sequence: event.sequence, openedAt: event.openedAt, kind: event.kind, outcome: event.outcome }
  }
  const requestId = nonEmptyString(event.requestId)
  return (event.kind === "permission" || event.kind === "question") && requestId
    ? { sequence: event.sequence, openedAt: event.openedAt, kind: event.kind, requestId }
    : undefined
}

export function sessionNoticeIdentity(raw: Record<string, unknown>) {
  const id = nonEmptyString(raw.sessionId)
  const workspace = nonEmptyString(raw.workspaceId)
  const project = nonEmptyString(raw.projectId)
  if (!id || !workspace || !project) throw contractMismatch("session notice reference")
  return { sessionId: sessionId(id), placementId: placementId(workspace), projectId: projectId(project) }
}

export function raisedSessionNotice(raw: Record<string, unknown>) {
  const event = parseNoticeAttentionEvent(raw.event)
  const generation = raw.generation
  if (!event || !positivePosition(generation) || event.sequence <= generation) throw contractMismatch("raised session attention")
  return { event, generation }
}

function noticeRef(frame: Frame, address: Address) {
  const ref = sessionNoticeIdentity(frame.raw)
  const placed = address.placementFor("", ref.placementId, ref.sessionId)
  return placed ? { ...ref, ...placed } : ref
}

export function sessionNoticeEvent(frame: Frame, address: Address): ServerEvent | undefined {
  const ref = noticeRef(frame, address)
  if (frame.type === "session.removed") return { type: "sessionRemoved", ref }
  const title = nonEmptyString(frame.raw.title)
  const delivery = frame.replayed ? "replay" : "live"
  if (frame.type === "session.status.changed") {
    const attention = parseSessionAttention(frame.raw.attention)
    if (!attention) throw contractMismatch("session notice attention")
    const lastTurn = parseAgentTurnOutcome(frame.raw.lastTurn)
    return { type: "attentionChanged", ref, attention, delivery, ...(lastTurn ? { lastTurn } : {}), ...(title ? { title } : {}) }
  }
  if (frame.type === "session.reader.changed") {
    const reader = parseSessionReader(frame.raw.reader)
    if (!reader) throw contractMismatch("session notice reader")
    return { type: "readerChanged", ref, reader }
  }
  if (frame.type !== "session.attention.raised") return undefined
  const { event, generation } = raisedSessionNotice(frame.raw)
  const parentSessionId = nonEmptyString(frame.raw.parentSessionId)
  return { type: "attentionRaised", ref, event, generation, delivery, ...(title ? { title } : {}), ...(parentSessionId ? { parentSessionId } : {}) }
}
