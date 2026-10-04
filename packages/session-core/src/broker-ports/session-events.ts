import { createClientPresentationProjection } from "../projection/client-presentation/projection"
import { projectSessionCommands } from "../projection/client-presentation/translate"
import { eventNoticePartId } from "../projection/client-presentation/notices"
import type { AgentRuntimeEvent, RuntimeDiagnostic, SubagentUpdatedEvent } from "@claxedo/agent-runtime-contract"
import type { OutsideTurnEvent, OutsideTurnUsage, RoutedEvent } from "@claxedo/harness/contract"
import { childRouteDropped, isMeteredUsage, parentScopedUsage, resolveChildRoute } from "../projection/child-routes"
import type { RuntimeStore } from "../store"
import type { BrokerBackgroundWork } from "./background-work"
import type { BrokerEventDelivery } from "./delivery"

export class BrokerSessionEvents {
  private readonly turnProjections = new Map<string, ReturnType<typeof createClientPresentationProjection>>()

  constructor(
    private readonly store: RuntimeStore,
    private readonly delivery: BrokerEventDelivery,
    private readonly backgroundWork: BrokerBackgroundWork,
  ) {}

  async drainProviderEvent(sessionId: string, turnId: string, routed: RoutedEvent): Promise<void> {
    if (routed.route?.kind === "child") return this.deliverChild(sessionId, routed, turnId)
    this.project(sessionId, turnId, routed.event, routed.source)
  }

  /**
   * A child-routed event goes where the store's binding sends it, whether a
   * parent turn is running or not. One the store cannot route is dropped with
   * one diagnostic on the parent; the tokens it carried stay on the parent's
   * running turn, when there is one.
   */
  drainChildEvent(sessionId: string, routed: RoutedEvent): Promise<void> {
    return this.deliverChild(sessionId, routed, undefined)
  }

  private async deliverChild(sessionId: string, routed: RoutedEvent, parentTurnId: string | undefined): Promise<void> {
    const correlationKey = routed.route?.kind === "child" ? routed.route.correlationKey : undefined
    const route = correlationKey ? resolveChildRoute(this.store, sessionId, correlationKey) : { kind: "uncorrelated" as const }
    if (route.kind === "bound") {
      this.project(route.childSessionId, route.assistantMessageId, routed.event, routed.source)
      return
    }
    if (route.kind === "finished") this.turnProjections.delete(JSON.stringify([route.childSessionId, route.assistantMessageId]))
    if (parentTurnId && isMeteredUsage(routed.event)) {
      this.project(sessionId, parentTurnId, parentScopedUsage(routed.event, correlationKey), routed.source)
    }
    await this.publishSessionEvent(sessionId, childRouteDropped(correlationKey, route, routed.event))
  }

  private project(sessionId: string, turnId: string, event: AgentRuntimeEvent, source: RoutedEvent["source"]): void {
    const session = this.store.getSession(sessionId) as { directory?: string } | null
    if (!session) throw new Error(`Unknown session ${sessionId}`)
    if (this.alreadyProjected(sessionId, event)) return
    const key = JSON.stringify([sessionId, turnId])
    let projection = this.turnProjections.get(key)
    if (!projection) {
      projection = createClientPresentationProjection({
        sessionId, directory: session.directory ?? "", assistantMessageId: turnId,
      })
      this.turnProjections.set(key, projection)
    }
    this.delivery.runtime(sessionId, event, turnId, () => {
      for (const envelope of projection.ingest(event)) this.delivery.append(sessionId, envelope.payload, source)
    })
  }

  releaseProviderTurn(sessionId: string, turnId: string): void {
    this.turnProjections.delete(JSON.stringify([sessionId, turnId]))
  }

  private alreadyProjected(sessionId: string, event: AgentRuntimeEvent): boolean {
    if (event.type !== "agent-message" && event.type !== "harness-notice") return false
    if (!event.eventId) return false
    return !!this.store.database().prepare<{ present: number }>(
      "SELECT 1 AS present FROM part WHERE session_id = ? AND id = ?",
    ).get(sessionId, eventNoticePartId(sessionId, event.eventId))
  }

  async publishSessionEvent(sessionId: string, event: OutsideTurnEvent | SubagentUpdatedEvent, assistantMessageId?: string): Promise<void> {
    const session = this.store.getSession(sessionId) as { directory?: string } | null
    if (!session) throw new Error(`Unknown session ${sessionId}`)
    if (assistantMessageId && this.store.messageSessionId(assistantMessageId) !== sessionId) {
      throw new Error(`Message ${assistantMessageId} does not belong to session ${sessionId}`)
    }
    if (this.alreadyProjected(sessionId, event)) return
    const directory = session.directory ?? ""
    if (event.type === "background-work") {
      this.delivery.runtime(sessionId, event, undefined, () => {
        this.backgroundWork.record(sessionId, { agents: event.agents, shells: event.shells, other: event.other })
      })
      return
    }
    if (event.type === "available-commands-update") {
      this.delivery.runtime(sessionId, event, undefined, () => {
        this.delivery.append(sessionId, projectSessionCommands(sessionId, directory, event).payload)
      })
      return
    }
    const projection = createClientPresentationProjection({
      sessionId, directory, assistantMessageId: assistantMessageId ?? "",
    })
    this.delivery.runtime(sessionId, event, assistantMessageId, () => {
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
