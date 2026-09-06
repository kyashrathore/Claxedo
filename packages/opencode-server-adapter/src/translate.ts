import { agentRuntimeEvent } from "@claxedo/agent-event-runtime"
import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import { OpenCodeServerAdapterError } from "./errors"

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

type TextState = { type: "text" | "reasoning"; text: string }
type ToolState = { input?: string; status?: string; snapshot: string }

export class OpenCodeEventTranslator {
  private readonly text = new Map<string, TextState>()
  private readonly tools = new Map<string, ToolState>()

  translate(event: OpenCodeLeafEvent): AgentRuntimeEvent[] {
    if (event.type === "message.part.delta") return this.delta(event.properties)
    if (event.type === "message.part.updated") {
      const part = record(event.properties.part)
      if (!part) return []
      if (part.type === "text" || part.type === "reasoning") return this.snapshot(part, part.type)
      if (part.type === "tool") return this.tool(part)
      return []
    }
    const translated = translateSessionEvent(event)
    return translated ? [translated] : []
  }

  private delta(properties: Record<string, unknown>): AgentRuntimeEvent[] {
    if (properties.field !== "text") return []
    const delta = string(properties.delta)
    if (!delta) return []
    const state = this.text.get(partKey(properties.messageID, properties.partID))
    if (!state) throw new OpenCodeServerAdapterError("reconciliation_gap", "OpenCode text delta arrived without its part snapshot")
    state.text += delta
    return [textDelta(state.type, delta)]
  }

  private snapshot(part: Record<string, unknown>, type: TextState["type"]): AgentRuntimeEvent[] {
    const key = partKey(part.messageID, part.id)
    const value = typeof part.text === "string" ? part.text : ""
    const previous = this.text.get(key)?.text ?? ""
    if (!value.startsWith(previous)) {
      throw new OpenCodeServerAdapterError("reconciliation_gap", "OpenCode replaced already emitted text; the runtime stream cannot represent this edit")
    }
    this.text.set(key, { type, text: value })
    return value.length > previous.length ? [textDelta(type, value.slice(previous.length))] : []
  }

  private tool(part: Record<string, unknown>): AgentRuntimeEvent[] {
    const state = record(part.state)
    if (!state || !["pending", "running", "completed", "error"].includes(String(state.status))) return []
    const key = partKey(part.messageID, part.id)
    const previous = this.tools.get(key)
    const snapshot = JSON.stringify(state)
    if (previous?.snapshot === snapshot) return []
    const toolCallId = string(part.callID)
    const toolName = string(part.tool)
    if (!toolCallId || !toolName) throw new OpenCodeServerAdapterError("invalid_event", "OpenCode tool part omitted its call ID or tool name")
    const metadata = { ...record(part.metadata), ...record(state.metadata) }
    const detail = { ...(Object.keys(metadata).length ? { metadata } : {}), ...(typeof state.title === "string" ? { display: { summary: state.title } } : {}) }
    const events: AgentRuntimeEvent[] = []
    if (!previous) events.push(agentRuntimeEvent.toolStart({ toolCallId, toolName, ...detail }))
    const input = state.input === undefined ? undefined : JSON.stringify(state.input)
    if (state.status !== "pending" && input !== undefined && previous?.input !== input) {
      events.push(agentRuntimeEvent.toolInput({ toolCallId, input: state.input, ...detail }))
    }
    if (state.status === "completed") events.push(agentRuntimeEvent.toolOutput({ toolCallId, output: state.output, ...detail }))
    else if (state.status === "error") events.push(agentRuntimeEvent.toolError({ toolCallId, error: errorText(state.error), ...detail }))
    else if (previous?.status !== state.status || previous?.snapshot !== snapshot) {
      events.push(agentRuntimeEvent.toolStatus({ toolCallId, status: state.status === "pending" ? "pending" : "running", ...detail }))
    }
    this.tools.set(key, { snapshot, status: String(state.status), ...(state.status !== "pending" && input !== undefined ? { input } : {}) })
    return events
  }
}

function textDelta(type: TextState["type"], delta: string) {
  return type === "reasoning" ? agentRuntimeEvent.thinkingDelta({ delta }) : agentRuntimeEvent.textDelta({ delta })
}

function translateSessionEvent(event: OpenCodeLeafEvent): AgentRuntimeEvent | undefined {
  if (event.type === "session.status") {
    const status = statusType(event.properties.status)
    return status ? agentRuntimeEvent.sessionStatus({ status }) : undefined
  }
  if (event.type === "session.idle") return agentRuntimeEvent.finish({ sessionId: string(event.properties.sessionID) ?? "" })
  if (event.type === "session.error") return agentRuntimeEvent.error({ error: errorText(event.properties.error) })
  if (event.type === "session.compacted") return agentRuntimeEvent.sessionCompaction({ phase: "completed" })
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
  return undefined
}

function partKey(messageId: unknown, partId: unknown) {
  const message = string(messageId)
  const part = string(partId)
  if (!message || !part) throw new OpenCodeServerAdapterError("invalid_event", "OpenCode part omitted its message ID or part ID")
  return `${message}:${part}`
}

function statusType(input: unknown) {
  const value = string(record(input)?.type) ?? string(input)
  if (value === "retry") return "recovering"
  return value === "busy" || value === "idle" || value === "error" || value === "recovering" ? value : undefined
}

export function errorText(input: unknown) {
  const value = record(input)
  return string(record(value?.data)?.message) ?? string(value?.message) ?? string(input) ?? "session error"
}

export function record(input: unknown): Record<string, unknown> | undefined {
  return isRecord(input) ? input : undefined
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
}

function string(input: unknown) { return typeof input === "string" && input.length > 0 ? input : undefined }
