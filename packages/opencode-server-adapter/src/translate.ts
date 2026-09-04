import { agentRuntimeEvent } from "@claxedo/agent-event-runtime"
import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"

export type OpenCodeLeafEvent = { type: string; properties: Record<string, unknown> }

export function openCodeEventSessionId(event: OpenCodeLeafEvent) {
  const info = record(event.properties.info)
  const part = record(event.properties.part)
  if (event.type === "session.updated") return string(info?.id)
  if (event.type === "message.updated") return string(info?.sessionID)
  return string(event.properties.sessionID) ?? string(part?.sessionID)
}

export function isUnsupportedInteractiveEvent(event: OpenCodeLeafEvent) {
  return event.type === "permission.asked" || event.type === "question.asked"
}

export function translateOpenCodeEvent(
  event: OpenCodeLeafEvent,
  content: Map<string, string>,
): AgentRuntimeEvent | undefined {
  if (event.type === "session.status") {
    const status = statusType(event.properties.status)
    return status ? agentRuntimeEvent.sessionStatus({ status }) : undefined
  }
  if (event.type === "session.idle") return agentRuntimeEvent.finish({ sessionId: string(event.properties.sessionID) ?? "" })
  if (event.type === "session.error") return agentRuntimeEvent.error({ error: errorText(event.properties.error) })
  if (event.type === "session.compacted") return agentRuntimeEvent.sessionCompaction({ phase: "completed" })
  if (event.type === "message.part.delta") {
    const delta = String(event.properties.delta ?? "")
    if (!delta) return
    if (event.properties.field === "thinking") return agentRuntimeEvent.thinkingDelta({ delta })
    if (event.properties.field !== "text") return
    return content.get(partTypeKey(event.properties.messageID, event.properties.partID)) === "reasoning"
      ? agentRuntimeEvent.thinkingDelta({ delta })
      : agentRuntimeEvent.textDelta({ delta })
  }
  if (event.type === "message.part.updated") {
    const part = record(event.properties.part)
    if (!part) return
    if (part.type === "text" || part.type === "reasoning") {
      const key = partKey(part.messageID, part.id)
      content.set(partTypeKey(part.messageID, part.id), String(part.type))
      const value = string(part.text) ?? ""
      const previous = content.get(key) ?? ""
      content.set(key, value)
      const delta = value.startsWith(previous) ? value.slice(previous.length) : value
      if (!delta) return
      return part.type === "reasoning"
        ? agentRuntimeEvent.thinkingDelta({ delta })
        : agentRuntimeEvent.textDelta({ delta })
    }
    if (part.type !== "tool") return
    const state = record(part.state)
    const callId = string(part.callID) ?? String(part.id)
    const tool = string(part.tool) ?? callId
    if (state?.status === "running") {
      return state.input === undefined
        ? agentRuntimeEvent.toolStart({ toolCallId: callId, toolName: tool })
        : agentRuntimeEvent.toolInput({ toolCallId: callId, input: state.input })
    }
    if (state?.status === "completed") return agentRuntimeEvent.toolOutput({ toolCallId: callId, output: state.output })
    if (state?.status === "error") return agentRuntimeEvent.toolError({ toolCallId: callId, error: errorText(state.error) })
    return
  }
  if (event.type === "todo.updated") {
    const todos = Array.isArray(event.properties.todos) ? event.properties.todos : []
    return agentRuntimeEvent.todoUpdate({
      todos: todos.map((item, index) => {
        const todo = record(item) ?? {}
        return {
          id: string(todo.id) ?? String(index),
          description: string(todo.content) ?? string(todo.description) ?? "",
          status: string(todo.status) ?? "pending",
          priority: string(todo.priority),
        }
      }),
    })
  }
  if (event.type === "session.updated") {
    const title = string(record(event.properties.info)?.title)
    return title ? agentRuntimeEvent.sessionTitle({ title }) : undefined
  }
  if (event.type === "session.agent") {
    const agentId = string(event.properties.agentId)
    return agentId ? agentRuntimeEvent.sessionAgent({ agentId }) : undefined
  }
}

function partKey(messageId: unknown, partId: unknown) { return `${String(messageId)}:${String(partId)}` }
function partTypeKey(messageId: unknown, partId: unknown) { return `part-type:${partKey(messageId, partId)}` }

function statusType(input: unknown) {
  const value = string(record(input)?.type) ?? string(input)
  return value === "busy" || value === "idle" || value === "error" || value === "recovering" ? value : undefined
}

function errorText(input: unknown) {
  const value = record(input)
  return string(record(value?.data)?.message) ?? string(value?.message) ?? string(input) ?? "session error"
}

export function record(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function string(input: unknown) { return typeof input === "string" && input.length > 0 ? input : undefined }
