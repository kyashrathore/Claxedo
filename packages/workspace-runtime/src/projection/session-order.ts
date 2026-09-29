import { eventSessionId, type CompatEnvelope } from "@claxedo/agent-sdk-runtime/compat-events"
import { asRecord } from "@claxedo/helpers/guards"
import type { RuntimeEventEnvelope } from "./runtime-event-hub"

/**
 * A session's place held for frames that belong after one turn's end and
 * before anything later: while it is open, the session's other frames wait in
 * publish order, except the frames of the turn that opened it, which are not
 * later than it. Closing publishes what waited.
 */
export type SessionSlot = {
  publishGlobal: (event: CompatEnvelope) => void
  close: () => void
}

type Held = { turnMessageId: string; waiting: Array<() => void> }

function compatTurnMessageId(event: CompatEnvelope): string | undefined {
  const { payload } = event
  const properties = asRecord(payload.properties)
  if (payload.type === "message.updated") {
    const id = asRecord(properties?.info)?.id
    return typeof id === "string" ? id : undefined
  }
  if (!payload.type.startsWith("message.") && payload.type !== "session.usage") return undefined
  const id = properties?.messageID ?? asRecord(properties?.part)?.messageID
  return typeof id === "string" ? id : undefined
}

export function createSessionOrder() {
  const slots = new Map<string, Held>()
  const deliver = (sessionId: string | undefined, turnMessageId: string | undefined, send: () => void) => {
    const held = sessionId === undefined ? undefined : slots.get(sessionId)
    if (!held || (turnMessageId !== undefined && turnMessageId === held.turnMessageId)) send()
    else held.waiting.push(send)
  }
  return {
    global: (event: CompatEnvelope, send: () => void) => deliver(eventSessionId(event.payload), compatTurnMessageId(event), send),
    runtime: (event: RuntimeEventEnvelope, send: () => void) => deliver(event.sessionId, event.assistantMessageId, send),
    sequence: (sessionId: string, send: () => void) => deliver(sessionId, undefined, send),
    open(sessionId: string, turnMessageId: string, publish: (event: CompatEnvelope) => void): SessionSlot {
      if (slots.has(sessionId)) throw new Error(`Session ${sessionId} already holds an ordered slot`)
      const held: Held = { turnMessageId, waiting: [] }
      slots.set(sessionId, held)
      return {
        publishGlobal: publish,
        close: () => {
          if (slots.get(sessionId) !== held) return
          slots.delete(sessionId)
          for (const send of held.waiting.splice(0)) send()
        },
      }
    },
  }
}
