import { createClientPresentationProjection } from "../projection/client-presentation/projection"
import { projectSessionCommands } from "../projection/client-presentation/translate"
import type { RuntimeDiagnostic, SubagentUpdatedEvent } from "@claxedo/agent-runtime-contract"
import type { OutsideTurnEvent, OutsideTurnUsage, RoutedEvent } from "@claxedo/harness/contract"
import type { RuntimeStore } from "../store"
import type { BrokerEventDelivery } from "./delivery"

export class BrokerSessionEvents {
  private readonly turnProjections = new Map<string, ReturnType<typeof createClientPresentationProjection>>()

  constructor(private readonly store: RuntimeStore, private readonly delivery: BrokerEventDelivery) {}

  async drainProviderEvent(sessionId: string, turnId: string, routed: RoutedEvent): Promise<void> {
    let targetSessionId = sessionId
    let targetTurnId = turnId
    if (routed.route?.kind === "child") {
      const correlationKey = routed.route.correlationKey
      if (!correlationKey) throw new Error("Child event routing requires a correlation key")
      const child = this.store.childRouteBinding(sessionId, correlationKey)
      if (!child) throw new Error(`Child event routing has no binding for ${correlationKey}`)
      targetSessionId = child.childSessionId
      targetTurnId = child.assistantMessageId
    }
    const session = this.store.getSession(targetSessionId) as { directory?: string } | null
    if (!session) throw new Error(`Unknown session ${targetSessionId}`)
    const key = JSON.stringify([targetSessionId, targetTurnId])
    let projection = this.turnProjections.get(key)
    if (!projection) {
      projection = createClientPresentationProjection({
        sessionId: targetSessionId, directory: session.directory ?? "", assistantMessageId: targetTurnId,
      })
      this.turnProjections.set(key, projection)
    }
    this.delivery.runtime(targetSessionId, routed.event, targetTurnId, () => {
      for (const envelope of projection.ingest(routed.event)) {
        this.delivery.append(targetSessionId, envelope.payload, routed.source)
      }
    })
  }

  releaseProviderTurn(sessionId: string, turnId: string): void {
    this.turnProjections.delete(JSON.stringify([sessionId, turnId]))
  }

  async publishSessionEvent(sessionId: string, event: OutsideTurnEvent | SubagentUpdatedEvent): Promise<void> {
    const session = this.store.getSession(sessionId) as { directory?: string } | null
    if (!session) throw new Error(`Unknown session ${sessionId}`)
    const directory = session.directory ?? ""
    if (event.type === "available-commands-update") {
      this.delivery.runtime(sessionId, event, undefined, () => {
        this.delivery.append(sessionId, projectSessionCommands(sessionId, directory, event).payload)
      })
      return
    }
    const projection = createClientPresentationProjection({
      sessionId, directory, assistantMessageId: "",
    })
    this.delivery.runtime(sessionId, event, undefined, () => {
      for (const envelope of projection.ingest(event)) this.delivery.append(sessionId, envelope.payload)
    })
  }

  meterUsage(usage: OutsideTurnUsage): void {
    const session = this.store.getSession(usage.sessionId) as { directory?: string } | null
    if (!session || session.directory !== usage.directory) throw new Error("Usage session directory differs")
    const projection = createClientPresentationProjection({
      sessionId: usage.sessionId, directory: usage.directory,
      assistantMessageId: usage.assistantMessageId,
    })
    this.delivery.runtime(usage.sessionId, usage.usage, usage.assistantMessageId, () => {
      for (const envelope of projection.ingest(usage.usage)) this.delivery.append(usage.sessionId, envelope.payload)
    })
  }

  async publishSubagent(parentSessionId: string, event: SubagentUpdatedEvent): Promise<void> {
    await this.publishSessionEvent(parentSessionId, event)
  }

  async publishSubagentDiagnostic(parentSessionId: string, diagnostic: RuntimeDiagnostic): Promise<void> {
    this.delivery.runtime(parentSessionId, { type: "diagnostic", diagnostic }, undefined, () => {
      this.delivery.append(parentSessionId, {
        id: `runtime.diagnostic:${parentSessionId}:${diagnostic.code}`,
        type: "runtime.diagnostic",
        properties: {
          sessionID: parentSessionId, code: diagnostic.code, message: diagnostic.message,
          severity: diagnostic.severity, diagnostic,
        },
      })
    })
  }
}
