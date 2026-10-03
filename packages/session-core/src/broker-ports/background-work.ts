import { backgroundWorkActive, NO_BACKGROUND_WORK, sameBackgroundWork, type BackgroundWork } from "@claxedo/agent-runtime-contract"
import { sessionBackgroundWork } from "../projection/presentation-events"
import type { RuntimeStore } from "../store"
import type { BrokerEventDelivery } from "./delivery"

export class BrokerBackgroundWork {
  private readonly sessions = new Map<string, BackgroundWork>()

  constructor(private readonly store: RuntimeStore, private readonly delivery: BrokerEventDelivery) {}

  read(sessionId: string): BackgroundWork | undefined {
    return this.sessions.get(sessionId)
  }

  activeSessions(): number {
    return this.sessions.size
  }

  record(sessionId: string, work: BackgroundWork): void {
    if (sameBackgroundWork(this.sessions.get(sessionId) ?? NO_BACKGROUND_WORK, work)) return
    if (backgroundWorkActive(work)) this.sessions.set(sessionId, work)
    else this.sessions.delete(sessionId)
    this.delivery.broadcast(sessionId, sessionBackgroundWork(sessionId, work))
  }

  retireAll(): void {
    const settled = [...this.sessions.keys()]
    this.sessions.clear()
    for (const sessionId of settled) {
      if (this.store.getSession(sessionId)) this.delivery.broadcast(sessionId, sessionBackgroundWork(sessionId, NO_BACKGROUND_WORK))
    }
  }
}
