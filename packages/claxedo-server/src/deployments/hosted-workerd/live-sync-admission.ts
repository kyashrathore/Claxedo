import { parseBackgroundWork, type SessionLastTurn } from "@claxedo/agent-runtime-contract"
import { storedSessionShareLevel } from "@claxedo/server-core/platform/auth/session-share-level"
import { asRecord, numberField } from "@claxedo/server-core/platform/json/index"
import { sessionReaderState } from "@claxedo/server-core/session/reader"
import type { ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"

function lastTurnOf(turn: Record<string, unknown> | undefined): SessionLastTurn | undefined {
  const status = turn?.status
  const completedAt = turn?.completedAt
  if (status !== "completed" && status !== "failed" && status !== "cancelled") return undefined
  return typeof completedAt === "number" && Number.isFinite(completedAt) ? { status, completedAt } : undefined
}

function sessionStatusEvent(row: Record<string, unknown>, ts: number): ControlPlaneEvent | undefined {
  const { ownerUserId, orgId, sessionId, workspaceId, status, awaitingInput } = row
  if (
    typeof ownerUserId !== "string" || !ownerUserId || typeof orgId !== "string" || !orgId
    || typeof sessionId !== "string" || typeof workspaceId !== "string" || typeof awaitingInput !== "boolean"
    || (status !== "idle" && status !== "busy" && status !== "retry" && status !== "interrupted")
  ) return undefined
  const backgroundWork = parseBackgroundWork(row.backgroundWork)
  const lastTurn = lastTurnOf(asRecord(row.lastTurn))
  return {
    type: "session.status.changed", ts, ownerUserId, orgId, sessionId, workspaceId, status, awaitingInput,
    ...(backgroundWork ? { backgroundWork } : {}),
    ...(lastTurn ? { lastTurn } : {}),
  }
}

/**
 * The events this room admits onto a client stream, a session share's
 * doorbell, a session's status notice and a reader's own marks, rebuilt field
 * by field so the room forwards exactly the fields it verified and nothing
 * else the sender put in the object.
 */
function liveSyncEvent(input: unknown): ControlPlaneEvent | undefined {
  const row = asRecord(input)
  const ts = row?.ts
  if (!row || typeof ts !== "number" || !Number.isFinite(ts)) return undefined
  if (row.type === "session.status.changed") return sessionStatusEvent(row, ts)
  const { ownerUserId, sessionId, workspaceId, phase } = row
  if (
    row.type === "session.share.changed"
    && typeof ownerUserId === "string" && ownerUserId
    && typeof sessionId === "string"
    && typeof workspaceId === "string"
    && (phase === "granted" || phase === "revoked")
  ) {
    const base = { type: "session.share.changed", ts, ownerUserId, sessionId, workspaceId } as const
    return phase === "granted"
      ? { ...base, phase, level: storedSessionShareLevel(row.level) }
      : { ...base, phase }
  }
  if (row.type === "session.reader.changed" && typeof ownerUserId === "string" && ownerUserId && typeof sessionId === "string" && typeof workspaceId === "string") {
    return { type: "session.reader.changed", ts, ownerUserId, sessionId, workspaceId, ...sessionReaderState(numberField(row, "seenAt"), numberField(row, "settledAt")) }
  }
  return undefined
}

/** A nudge's events, one or a batch for one room; nothing when any of them is not admitted. */
export function liveSyncEvents(input: unknown): ControlPlaneEvent[] | undefined {
  const events = (Array.isArray(input) ? input : [input]).map(liveSyncEvent)
  return events.length > 0 && events.every((event) => event !== undefined) ? events : undefined
}
