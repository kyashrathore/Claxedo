import type { AgentPresentationEvent, AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"

export type RuntimeAppendSource = {
  dir: "in" | "out"
  method: string
  requestId?: string
}

export type SessionEventContext = {
  sessionId: string
  directory: string | undefined
  agentSessionId?: string
  assistantMessageId?: string
  source?: RuntimeAppendSource
  fencingToken?: number
}

export type SessionEventStore = {
  appendEvent(input: {
    sessionId: string
    agentSessionId?: string
    payload: AgentPresentationEvent
    source?: RuntimeAppendSource
    fencingToken?: number
  }): { payload: AgentPresentationEvent; messageUpdate?: AgentPresentationEvent }
}

export function createSessionEventWriter(deps: {
  store: SessionEventStore
  publishPresentation: (context: SessionEventContext, payload: AgentPresentationEvent) => void
  publishRuntime?: (context: SessionEventContext, payload: AgentRuntimeEvent) => void
}) {
  const commit = (context: SessionEventContext, payload: AgentPresentationEvent) => {
    const output = deps.store.appendEvent({
      sessionId: context.sessionId,
      ...(context.agentSessionId ? { agentSessionId: context.agentSessionId } : {}),
      payload,
      ...(context.source ? { source: context.source } : {}),
      ...(context.fencingToken !== undefined ? { fencingToken: context.fencingToken } : {}),
    })
    if (!output) throw new Error("Runtime store appendEvent must return committed output")
    return output
  }
  const publishCommitted = (context: SessionEventContext, output: ReturnType<typeof commit>,
    publish = deps.publishPresentation) => {
    publish(context, output.payload)
    if (output.messageUpdate) deps.publishPresentation(context, output.messageUpdate)
    return output.payload
  }
  return {
    writePresentation(context: SessionEventContext, payload: AgentPresentationEvent, publish = deps.publishPresentation) {
      return publishCommitted(context, commit(context, payload), publish)
    },
    async writePresentationAfter(context: SessionEventContext, payload: AgentPresentationEvent, beforePublish: () => Promise<void>) {
      const output = commit(context, payload)
      await beforePublish()
      return publishCommitted(context, output)
    },
    writeRuntime(context: SessionEventContext, payload: AgentRuntimeEvent, project: () => void) {
      project()
      deps.publishRuntime?.(context, payload)
    },
  }
}
