import { backgroundWorkActive, NO_BACKGROUND_WORK, sameBackgroundWork, type BackgroundWork } from "@claxedo/agent-runtime-contract"
import { sessionBackgroundWork } from "../projection/presentation-events"
import type { RuntimeStore } from "../store"
import type { BrokerEventDelivery } from "./delivery"

export class BrokerBackgroundWork {
  private readonly sessions = new Map<string, BackgroundWork>()

  constructor(private readonly store: RuntimeStore, private readonly delivery: BrokerEventDelivery) {}

  read(sessionId: string): BackgroundWork | undefined {
    const current = this.sessions.get(sessionId)
    if (current) return current
    const restored = this.store.getSession(sessionId)?.backgroundWork
    if (!restored || !backgroundWorkActive(restored)) return undefined
    this.sessions.set(sessionId, restored)
    return restored
  }

  record(sessionId: string, work: BackgroundWork): void {
    if (sameBackgroundWork(this.read(sessionId) ?? NO_BACKGROUND_WORK, work)) return
    this.delivery.append(sessionId, sessionBackgroundWork(sessionId, work))
    if (backgroundWorkActive(work)) this.sessions.set(sessionId, work)
    else this.sessions.delete(sessionId)
  }

  retireAll(): void {
    const settled = [...this.sessions.keys()]
    for (const sessionId of settled) {
      if (this.store.getSession(sessionId)) this.delivery.append(sessionId, sessionBackgroundWork(sessionId, NO_BACKGROUND_WORK))
      this.sessions.delete(sessionId)
    }
  }
}
