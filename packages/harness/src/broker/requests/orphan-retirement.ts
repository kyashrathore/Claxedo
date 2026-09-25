import type { RequestScope } from "../../contract/broker"
import type { BrokerPorts } from "../ports"
import { requestKey } from "./request-key"

export class OrphanRetirement {
  private readonly retiring = new Map<string, Promise<void>>()

  constructor(private readonly ports: BrokerPorts) {}

  retire(scope: RequestScope, live: (key: string) => boolean): void {
    for (const pending of this.ports.readPending(scope)) {
      const key = requestKey(pending.sessionId, pending.request.requestId)
      if (live(key) || this.retiring.has(key) || this.ports.readAnswer(pending.sessionId, pending.request.requestId)) continue
      const write = this.ports.persistAnswer(pending, { kind: "cancelled" }, false)
        .then(() => undefined, (error: unknown) => this.ports.reportOwnerFailure(pending.sessionId, error))
        .finally(() => this.retiring.delete(key))
      this.retiring.set(key, write)
    }
  }

  settled(key: string): Promise<void> {
    return this.retiring.get(key) ?? Promise.resolve()
  }
}
