import type { ServerEvent } from "./events"

const MAX_TRACKED_ATTENTION_EVENTS = 10_000

export function createAttentionReceipts() {
  const received = new Set<string>()
  return (event: ServerEvent): boolean => {
    if (event.type !== "attentionRaised") return true
    const key = JSON.stringify([event.ref.placementId, event.ref.sessionId, event.generation, event.event.sequence, event.event.kind])
    if (received.has(key)) return false
    received.add(key)
    if (received.size > MAX_TRACKED_ATTENTION_EVENTS) received.delete(received.values().next().value!)
    return true
  }
}
