import { backgroundWorkActive, type ServerEvent, type SessionLocation } from "@/server"
import type { SessionAttention } from "@/session"
import type { SessionListInternal } from "../list"

type HeldRows = Pick<SessionListInternal, "rowOf" | "view" | "statusOf" | "backgroundWorkOf">

type StatusEvent = Extract<ServerEvent, { type: "statusChanged" }>

function turnEndAttention(event: StatusEvent, held: HeldRows): SessionAttention[] {
  const turn = event.lastTurn
  const failed = held.statusOf(event.ref.sessionId).kind === "failed" ? [] : [{ kind: "failed" as const, ref: event.ref }]
  if (!turn) return event.status.kind === "failed" ? failed : []
  if (turn.status === "cancelled") return []
  const known = held.rowOf(event.ref.sessionId)?.lastTurn?.completedAt
  if (known !== undefined && turn.completedAt <= known) return []
  if (turn.status === "failed") return failed
  return backgroundWorkActive(event.backgroundWork ?? held.backgroundWorkOf(event.ref.sessionId)) ? [] : [{ kind: "finished", ref: event.ref }]
}

function waitRose(waiting: boolean | undefined, event: { readonly ref: SessionLocation }, held: HeldRows): SessionAttention[] {
  return waiting && !held.view(event.ref.sessionId)?.waitingOnUser ? [{ kind: "waiting", ref: event.ref }] : []
}

export function attentionRaised(event: ServerEvent, held: HeldRows): SessionAttention[] {
  if (event.type === "requestOpened") return waitRose(true, event, held)
  if (event.type !== "statusChanged" || event.replayed) return []
  return [...waitRose(event.waitingOnUser, event, held), ...turnEndAttention(event, held)]
}

export function createAttentionChannel() {
  const listeners = new Set<(attention: SessionAttention) => void>()
  return {
    raise: (raised: readonly SessionAttention[]) => {
      for (const attention of raised) for (const listener of listeners) listener(attention)
    },
    subscribe: (listener: (attention: SessionAttention) => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    clear: () => listeners.clear(),
  }
}
