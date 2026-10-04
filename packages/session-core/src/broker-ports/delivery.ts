import type { AgentRuntimeEvent, AgentPresentationEvent } from "@claxedo/agent-runtime-contract"
import type { RuntimeEventPublishers } from "../projection/runtime-event-hub"
import type { RuntimeStore, RuntimeEventSource } from "../store"
import { createSessionEventWriter } from "../projection/session-event-writer"

export class BrokerEventDelivery {
  private readonly writer

  constructor(private readonly store: RuntimeStore, private readonly publishers: RuntimeEventPublishers) {
    this.writer = createSessionEventWriter({
      store,
      publishPresentation: (context, payload) => this.broadcast(context.sessionId, payload),
      publishRuntime: (context, payload) => publishers.publishRuntime({
        sessionId: context.sessionId, directory: this.directory(context.sessionId),
        agentSessionId: context.agentSessionId,
        ...(context.assistantMessageId ? { assistantMessageId: context.assistantMessageId } : {}), payload,
      }),
    })
  }

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
    this.writer.writePresentation({ sessionId, directory: this.directory(sessionId), source }, payload)
  }

  runtime(sessionId: string, payload: AgentRuntimeEvent, assistantMessageId: string | undefined,
    project: () => void): void {
    this.writer.writeRuntime({
      sessionId, directory: this.directory(sessionId),
      agentSessionId: this.store.getAgentSessionId(sessionId) ?? undefined,
      ...(assistantMessageId ? { assistantMessageId } : {}),
    }, payload, project)
  }
}
