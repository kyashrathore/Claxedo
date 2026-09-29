import { eventSessionId, type CompatEnvelope } from "@claxedo/agent-sdk-runtime/compat-events"
import { asRecord } from "@claxedo/helpers/guards"
import type { RuntimeEventEnvelope } from "./runtime-event-hub"

/**
 * A session's place held for frames that belong after one turn's end: while
 * it is open, the session's frames that belong to no turn wait in publish
 * order behind it, and the frames of the turn that opened it pass. The first
 * frame of a later turn releases it at once, so a later turn is never held;
 * closing it releases it too.
 */
export type SessionSlot = {
  publishGlobal: (event: CompatEnvelope) => void
  close: () => void
}

type Held = { turnMessageId: string; waiting: Array<() => void> }

type FrameTurn = { messageId?: string; starts: boolean }

function compatFrameTurn(event: CompatEnvelope): FrameTurn {
  const { payload } = event
  const properties = asRecord(payload.properties)
  if (payload.type === "session.status") return { starts: asRecord(properties?.status)?.type === "busy" }
  if (payload.type === "message.updated") {
    const id = asRecord(properties?.info)?.id
    return typeof id === "string" ? { messageId: id, starts: false } : { starts: false }
  }
  if (!payload.type.startsWith("message.") && payload.type !== "session.usage") return { starts: false }
  const id = properties?.messageID ?? asRecord(properties?.part)?.messageID
  return typeof id === "string" ? { messageId: id, starts: false } : { starts: false }
}

export function createSessionOrder() {
  const slots = new Map<string, Held>()
  const release = (sessionId: string, held: Held) => {
    if (slots.get(sessionId) !== held) return
    slots.delete(sessionId)
    for (const send of held.waiting.splice(0)) send()
  }
  const deliver = (sessionId: string | undefined, turn: FrameTurn, send: () => void) => {
    const held = sessionId === undefined ? undefined : slots.get(sessionId)
    if (sessionId === undefined || !held || turn.messageId === held.turnMessageId) send()
    else if (!turn.starts && turn.messageId === undefined) held.waiting.push(send)
    else {
      release(sessionId, held)
      send()
    }
  }
  return {
    global: (event: CompatEnvelope, send: () => void) => deliver(eventSessionId(event.payload), compatFrameTurn(event), send),
    runtime: (event: RuntimeEventEnvelope, send: () => void) =>
      deliver(event.sessionId, { starts: false, ...(event.assistantMessageId ? { messageId: event.assistantMessageId } : {}) }, send),
    sequence: (sessionId: string, send: () => void) => deliver(sessionId, { starts: false }, send),
    open(sessionId: string, turnMessageId: string, publish: (event: CompatEnvelope) => void): SessionSlot {
      if (slots.has(sessionId)) throw new Error(`Session ${sessionId} already holds an ordered slot`)
      const held: Held = { turnMessageId, waiting: [] }
      slots.set(sessionId, held)
      return { publishGlobal: publish, close: () => release(sessionId, held) }
    },
  }
}
