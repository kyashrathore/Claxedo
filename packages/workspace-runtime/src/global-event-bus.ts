import type { CompatEnvelope } from "./compat-events"

type Subscriber = (event: CompatEnvelope) => void

const subscribers = new Set<Subscriber>()

export function publishGlobalEvent(event: CompatEnvelope): void {
  for (const sub of subscribers) {
    sub(event)
  }
}

export function subscribeGlobalEvents(fn: Subscriber): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}
