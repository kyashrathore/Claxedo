import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import { createOpencodeCompatProjection } from "@claxedo/agent-event-runtime/projections/opencode-compat"
import {
  buildAssistantMessage,
  messageUpdated,
  type CompatEvent,
} from "../../compat-events"
import type { RuntimeEventEnvelopeInput } from "../../runtime-event-hub"
import type { PromptInput } from "../../index"

export type RuntimeAppendSource = {
  dir: "in" | "out"
  method: string
  requestId?: string
  frame?: unknown
}

type RuntimeEventStore = {
  appendEvent(input: {
    sessionId: string
    agentSessionId?: string
    payload: CompatEvent
    source?: RuntimeAppendSource
  }): { payload: CompatEvent }
}

function committed(payload: { payload: CompatEvent }) {
  if (!payload) throw new Error("Runtime store appendEvent must return committed output")
  return payload.payload
}

export function createTurnEventProjector(options: {
  store: RuntimeEventStore
  sessionId: string
  getAgentSessionId: () => string
  directory: string
  input: Pick<PromptInput, "userMessageId" | "agent" | "model" | "variant">
  assistantMessageId: string
  created: number
  onEvent: (event: CompatEvent) => void
  onRuntimeEvent?: (event: RuntimeEventEnvelopeInput) => void
}) {
  let assistantMessageId = options.assistantMessageId
  let created = options.created
  const runtimeProjectionMessageId = options.assistantMessageId
  const projection = createOpencodeCompatProjection({
    sessionId: options.sessionId,
    directory: options.directory,
    assistantMessageId,
  })
  const publishRuntime = (payload: AgentRuntimeEvent) => {
    options.onRuntimeEvent?.({
      directory: options.directory,
      sessionId: options.sessionId,
      agentSessionId: options.getAgentSessionId(),
      assistantMessageId: runtimeProjectionMessageId,
      payload,
    })
  }
  const append = (payload: CompatEvent, source: RuntimeAppendSource) => {
    const output = committed(options.store.appendEvent({
      sessionId: options.sessionId,
      agentSessionId: options.getAgentSessionId(),
      payload,
      source,
    }))
    options.onEvent(output)
    return output
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
        sessionID: options.sessionId,
        parentID: options.input.userMessageId ?? options.sessionId,
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
        const output = committed(options.store.appendEvent({
          sessionId: options.sessionId,
          agentSessionId: options.getAgentSessionId(),
          payload,
          source,
        }))
        const runtimeEvent = terminalizedToolRuntimeEvent(output, message)
        if (runtimeEvent) publishRuntime(runtimeEvent)
        return output
      })
    },
  }
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function terminalizedToolRuntimeEvent(payload: CompatEvent, message: string): AgentRuntimeEvent | undefined {
  if (payload.type !== "message.part.updated") return
  const part = record(payload.properties.part)
  if (part?.type !== "tool") return
  const state = record(part.state)
  if (state?.status !== "error") return
  const toolCallId = typeof part.callID === "string"
    ? part.callID
    : typeof part.id === "string"
      ? part.id
      : undefined
  if (!toolCallId) return
  return {
    type: "tool-error",
    toolCallId,
    error: typeof state.error === "string" ? state.error : message,
  }
}
