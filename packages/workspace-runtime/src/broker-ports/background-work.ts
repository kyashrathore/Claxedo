import { sessionBackgroundWork } from "../projection/presentation-events"
import type { RuntimeStore } from "../store"
import type { BrokerEventDelivery } from "./delivery"

export class BrokerBackgroundWork {
  private readonly sessions = new Set<string>()

  constructor(private readonly store: RuntimeStore, private readonly delivery: BrokerEventDelivery) {}

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  record(sessionId: string, active: boolean): void {
    if (this.sessions.has(sessionId) === active) return
    if (active) this.sessions.add(sessionId)
    else this.sessions.delete(sessionId)
    this.delivery.broadcast(sessionId, sessionBackgroundWork(sessionId, active))
  }

  retireAll(): void {
    const settled = [...this.sessions]
    this.sessions.clear()
    for (const sessionId of settled) {
      if (this.store.getSession(sessionId)) this.delivery.broadcast(sessionId, sessionBackgroundWork(sessionId, false))
    }
  }
}
