import type { AgentPresentationEvent } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { RuntimeEventPublishers } from "../projection/runtime-event-hub"
import type { RuntimeStore, RuntimeEventSource } from "../store"

export class BrokerEventDelivery {
  constructor(private readonly store: RuntimeStore, private readonly publishers: RuntimeEventPublishers) {}

  directory(sessionId: string): string {
    const session = this.store.getSession(sessionId) as { directory?: string } | null
    if (session?.directory) return session.directory
    const start = this.store.sessionStarts.get(sessionId)
    if (start) return start.binding.directory
    throw new Error(`Session ${sessionId} has no directory`)
  }

  broadcast(sessionId: string, payload: AgentPresentationEvent): void {
    this.publishers.publishGlobal({ directory: this.directory(sessionId), payload })
  }

  append(sessionId: string, payload: AgentPresentationEvent, source?: RuntimeEventSource): void {
    const committed = this.store.appendEvent({
      sessionId, payload, ...(source ? { source } : {}),
    })
    this.broadcast(sessionId, committed.payload)
    if (committed.messageUpdate) this.broadcast(sessionId, committed.messageUpdate)
  }

  runtime(sessionId: string, payload: AgentRuntimeEvent, assistantMessageId?: string): void {
    this.publishers.publishRuntime({
      sessionId, directory: this.directory(sessionId),
      agentSessionId: this.store.getAgentSessionId(sessionId) ?? undefined,
      ...(assistantMessageId ? { assistantMessageId } : {}), payload,
    })
  }
}
