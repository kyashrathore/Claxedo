import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { createClientPresentationProjection } from "./client-presentation/projection"
import { asRecord } from "@claxedo/helpers/guards"
import { buildAssistantMessage, messageUpdated, type AgentPresentationEvent } from "@claxedo/agent-runtime-contract"
import type { RuntimeEventEnvelopeInput } from "./runtime-event-hub"
import type { PromptInput } from "@claxedo/agent-runtime-contract"

export type RuntimeAppendSource = {
  dir: "in" | "out"
  method: string
  requestId?: string
}

export type TurnProjectionOwner = {
  sessionId: string
  getAgentSessionId: () => string
}

type RuntimeEventStore = {
  appendEvent(input: {
    sessionId: string
    agentSessionId?: string
    payload: AgentPresentationEvent
    source?: RuntimeAppendSource
    fencingToken?: number
  }): { payload: AgentPresentationEvent; messageUpdate?: AgentPresentationEvent }
}

function committed(output: { payload: AgentPresentationEvent; messageUpdate?: AgentPresentationEvent }) {
  if (!output) throw new Error("Runtime store appendEvent must return committed output")
  return output
}

export function createTurnEventProjector(options: {
  store: RuntimeEventStore
  owner: TurnProjectionOwner
  directory: string
  input: Pick<PromptInput, "userMessageId" | "parentMessageId" | "agent" | "model" | "variant">
  assistantMessageId: string
  created: number
  fencingToken?: number
  onEvent: (event: AgentPresentationEvent) => void
  onRuntimeEvent?: (event: RuntimeEventEnvelopeInput) => void
}) {
  let assistantMessageId = options.assistantMessageId
  let created = options.created
  const runtimeProjectionMessageId = options.assistantMessageId
  const projection = createClientPresentationProjection({
    sessionId: options.owner.sessionId,
    directory: options.directory,
    assistantMessageId,
  })
  const publishRuntime = (payload: AgentRuntimeEvent) => {
    options.onRuntimeEvent?.({
      directory: options.directory,
      sessionId: options.owner.sessionId,
      agentSessionId: options.owner.getAgentSessionId(),
      assistantMessageId: runtimeProjectionMessageId,
      payload,
    })
  }
  const append = (payload: AgentPresentationEvent, source: RuntimeAppendSource) => {
    const output = committed(options.store.appendEvent({
      sessionId: options.owner.sessionId,
      agentSessionId: options.owner.getAgentSessionId(),
      payload,
      source,
      ...(options.fencingToken !== undefined ? { fencingToken: options.fencingToken } : {}),
    }))
    options.onEvent(output.payload)
    if (output.messageUpdate) options.onEvent(output.messageUpdate)
  }

  return {
    assistantMessageId() {
      return assistantMessageId
    },
    created() {
      return created
    },
    project(runtimeEvent: AgentRuntimeEvent, source: RuntimeAppendSource) {
      for (const event of projection.ingest(runtimeEvent)) append(event.payload, source)
      if (runtimeEvent.type !== "step-start") {
        publishRuntime(runtimeEvent)
        return
      }

      assistantMessageId = runtimeEvent.newMessageId
      created = Date.now()
      append(messageUpdated(buildAssistantMessage({
        id: assistantMessageId,
        sessionID: options.owner.sessionId,
        parentID: options.input.userMessageId ?? options.input.parentMessageId ?? options.owner.sessionId,
        agent: options.input.agent,
        model: options.input.model,
        directory: options.directory,
        created,
      })), source)
      publishRuntime(runtimeEvent)
    },
    terminalizeOpenTools(message: string, source: RuntimeAppendSource) {
      return projection.terminalizeOpenTools(message).map((event) => {
        const payload = event.payload
        const appended = committed(options.store.appendEvent({
          sessionId: options.owner.sessionId,
          agentSessionId: options.owner.getAgentSessionId(),
          payload,
          source,
          ...(options.fencingToken !== undefined ? { fencingToken: options.fencingToken } : {}),
        }))
        if (appended.messageUpdate) options.onEvent(appended.messageUpdate)
        const output = appended.payload
        const runtimeEvent = terminalizedToolRuntimeEvent(output, message)
        if (runtimeEvent) publishRuntime(runtimeEvent)
        return output
      })
    },
  }
}

export type TurnEventProjector = ReturnType<typeof createTurnEventProjector>

function terminalizedToolRuntimeEvent(payload: AgentPresentationEvent, message: string): AgentRuntimeEvent | undefined {
  if (payload.type !== "message.part.updated") return undefined
  const part = asRecord(payload.properties.part)
  if (part?.type !== "tool") return undefined
  const state = asRecord(part.state)
  if (state?.status !== "error") return undefined
  const toolCallId = typeof part.callID === "string"
    ? part.callID
    : typeof part.id === "string"
      ? part.id
      : undefined
  if (!toolCallId) return undefined
  return {
    type: "tool-error",
    toolCallId,
    error: typeof state.error === "string" ? state.error : message,
  }
}
