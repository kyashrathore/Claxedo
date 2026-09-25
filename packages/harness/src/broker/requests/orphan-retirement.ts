import type { RequestScope } from "../../contract/broker"
import type { BrokerPorts } from "../ports"

export class OrphanRetirement {
  private readonly retiring = new Set<string>()

  constructor(private readonly ports: BrokerPorts) {}

  retire(scope: RequestScope, live: (sessionId: string, requestId: string) => boolean): void {
    for (const pending of this.ports.readPending(scope)) {
      const key = JSON.stringify([pending.sessionId, pending.request.requestId])
      if (live(pending.sessionId, pending.request.requestId) || this.retiring.has(key) ||
        this.ports.readAnswer(pending.sessionId, pending.request.requestId)) continue
      this.retiring.add(key)
      void this.ports.persistAnswer(pending, { kind: "cancelled" }, false)
        .catch((error: unknown) => this.ports.reportOwnerFailure(pending.sessionId, error))
        .finally(() => this.retiring.delete(key))
    }
  }
}
