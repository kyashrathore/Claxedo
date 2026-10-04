import type { SessionNotification } from "@agentclientprotocol/sdk"
import type { SessionBroker, TurnBroker } from "../../contract"
import { createAgentEventRuntime } from "../../translate/runtime"
import { routedIngest } from "../../translate/ingest"
import { createAcpEventTranslator } from "./translate/event-translator"
import { acpSubagentObservation } from "./extensions/subagents"

export class AcpChildren {
  private readonly active = new Set<string>()
  private readonly settled = new Set<string>()
  private readonly runtimes = new Map<string, ReturnType<typeof createAgentEventRuntime>>()

  constructor(private readonly harnessId: string, private readonly broker: SessionBroker) {}

  get hasLive(): boolean { return this.active.size > 0 }

  async observe(update: unknown, broker: TurnBroker | SessionBroker): Promise<void> {
    const child = acpSubagentObservation(update)
    if (!child) return
    if (child.observation.status === "running" && !this.settled.has(child.key)) this.active.add(child.key)
    const ref = await broker.observeSubagent(child.observation)
    if (ref) broker.associateChild(child.key, ref)
    if (child.observation.status !== "running") { this.active.delete(child.key); this.settled.add(child.key) }
  }

  async deliver(notification: SessionNotification): Promise<void> {
    if (!this.active.has(notification.sessionId) && !this.settled.has(notification.sessionId)) return
    let runtime = this.runtimes.get(notification.sessionId)
    if (!runtime) {
      runtime = createAgentEventRuntime({ harness: this.harnessId, threadId: notification.sessionId,
        adapter: createAcpEventTranslator({ client: this.harnessId }) })
      this.runtimes.set(notification.sessionId, runtime)
    }
    const events = routedIngest(runtime, { source: "acp.jsonrpc", method: "session/update", payload: notification.update }, {
      method: "session/update", target: { kind: "child", correlationKey: notification.sessionId },
    })
    for (const event of events) await this.broker.publishChild(event)
  }
}
