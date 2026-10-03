import { backgroundWorkActive, type ServerEvent } from "@/server"
import type { SessionAttention } from "@/session"
import type { SessionListInternal } from "../list"

type HeldRows = Pick<SessionListInternal, "rowOf" | "view" | "backgroundWorkOf">

type StatusEvent = Extract<ServerEvent, { type: "statusChanged" }>

function turnEndAttention(event: StatusEvent, held: HeldRows): SessionAttention | undefined {
  const turn = event.lastTurn
  if (!turn || turn.status === "cancelled") return undefined
  const known = held.rowOf(event.ref.sessionId)?.lastTurn?.completedAt
  if (known !== undefined && turn.completedAt <= known) return undefined
  if (turn.status === "failed") return { kind: "failed", ref: event.ref }
  return backgroundWorkActive(event.backgroundWork ?? held.backgroundWorkOf(event.ref.sessionId)) ? undefined : { kind: "finished", ref: event.ref }
}

export function attentionRaised(event: ServerEvent, held: HeldRows): SessionAttention | undefined {
  if (event.type === "requestOpened") return event.request.kind === "permission" ? { kind: "waiting", ref: event.ref } : undefined
  if (event.type !== "statusChanged" || event.replayed) return undefined
  if (event.waitingOnUser && !held.view(event.ref.sessionId)?.waitingOnUser) return { kind: "waiting", ref: event.ref }
  return turnEndAttention(event, held)
}

export function createAttentionChannel() {
  const listeners = new Set<(attention: SessionAttention) => void>()
  return {
    raise: (attention: SessionAttention | undefined) => {
      if (attention) for (const listener of listeners) listener(attention)
    },
    subscribe: (listener: (attention: SessionAttention) => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    clear: () => listeners.clear(),
  }
}
