import { agentRuntimeEvent, type AgentRuntimeEvent, type RuntimeStatus } from "../../contracts/agent-runtime-event"

type CompatEventInput = {
  type: string
  properties: Record<string, unknown>
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function text(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

function errorText(input: unknown) {
  const row = record(input)
  const data = record(row?.data)
  return text(data?.message) ?? text(row?.message) ?? text(input) ?? "session error"
}

function runtimeStatus(input: unknown): RuntimeStatus | undefined {
  const value = text(record(input)?.type) ?? text(input)
  if (value === "busy" || value === "idle" || value === "error" || value === "recovering") return value
}

function partKey(messageID: unknown, partID: unknown) {
  return `${String(messageID)}:${String(partID)}`
}

function partTypeKey(messageID: unknown, partID: unknown) {
  return `part-type:${partKey(messageID, partID)}`
}

export function legacyRuntimeEventFromOpencodeCompat(
  event: CompatEventInput,
  content: Map<string, string>,
): { payload: AgentRuntimeEvent; assistantMessageId?: string } | undefined {
  if (event.type === "session.status") {
    const status = runtimeStatus(event.properties.status)
    return status ? { payload: agentRuntimeEvent.sessionStatus({ status }) } : undefined
  }
  if (event.type === "session.idle") {
    return { payload: agentRuntimeEvent.finish({ sessionId: text(event.properties.sessionID) ?? "" }) }
  }
  if (event.type === "session.compacted") {
    return { payload: agentRuntimeEvent.sessionCompaction({ phase: "completed" }) }
  }
  if (event.type === "session.error") {
    return {
      payload: agentRuntimeEvent.error({ error: errorText(event.properties.error) }),
    }
  }
  if (event.type === "message.part.delta") {
    if (event.properties.field === "text") {
      const partType = content.get(partTypeKey(event.properties.messageID, event.properties.partID))
      return {
        assistantMessageId: text(event.properties.messageID),
        payload: partType === "reasoning"
          ? agentRuntimeEvent.thinkingDelta({ delta: String(event.properties.delta ?? "") })
          : agentRuntimeEvent.textDelta({ delta: String(event.properties.delta ?? "") }),
      }
    }
    if (event.properties.field === "thinking") {
      return {
        assistantMessageId: text(event.properties.messageID),
        payload: agentRuntimeEvent.thinkingDelta({ delta: String(event.properties.delta ?? "") }),
      }
    }
    return
  }
  if (event.type === "message.part.updated") {
    const part = record(event.properties.part)
    if (!part) return
    if (part.type === "text" || part.type === "reasoning") {
      const key = partKey(part.messageID, part.id)
      content.set(partTypeKey(part.messageID, part.id), String(part.type))
      const value = text(part.text) ?? ""
      const previous = content.get(key) ?? ""
      content.set(key, value)
      const delta = value.startsWith(previous) ? value.slice(previous.length) : value
      if (!delta) return
      return {
        assistantMessageId: text(part.messageID),
        payload: part.type === "reasoning"
          ? agentRuntimeEvent.thinkingDelta({ delta })
          : agentRuntimeEvent.textDelta({ delta }),
      }
    }
    if (part.type !== "tool") return
    const state = record(part.state)
    const callID = text(part.callID) ?? String(part.id)
    const tool = text(part.tool) ?? callID
    if (state?.status === "running") {
      const input = state.input === undefined ? undefined : state.input
      return {
        assistantMessageId: text(part.messageID),
        payload: input === undefined
          ? agentRuntimeEvent.toolStart({ toolCallId: callID, toolName: tool })
          : agentRuntimeEvent.toolInput({ toolCallId: callID, input }),
      }
    }
    if (state?.status === "completed") {
      return {
        assistantMessageId: text(part.messageID),
        payload: agentRuntimeEvent.toolOutput({ toolCallId: callID, output: state.output }),
      }
    }
    if (state?.status === "error") {
      return {
        assistantMessageId: text(part.messageID),
        payload: agentRuntimeEvent.toolError({ toolCallId: callID, error: errorText(state.error) }),
      }
    }
    return
  }
  if (event.type === "permission.asked") {
    const properties = record(event.properties) ?? {}
    return {
      payload: agentRuntimeEvent.permissionRequest({
        requestId: text(properties.id) ?? text(properties.permissionID) ?? "permission",
        tool: text(properties.permission) ?? "permission",
        paths: Array.isArray(properties.patterns) ? properties.patterns.filter((item): item is string => typeof item === "string") : [],
      }),
    }
  }
  if (event.type === "todo.updated") {
    const todos = Array.isArray(event.properties.todos) ? event.properties.todos : []
    return {
      payload: agentRuntimeEvent.todoUpdate({
        todos: todos.map((todo, index) => {
          const row = record(todo) ?? {}
          return {
            id: text(row.id) ?? String(index),
            description: text(row.content) ?? text(row.description) ?? "",
            status: text(row.status) ?? "pending",
            priority: text(row.priority),
          }
        }),
      }),
    }
  }
  if (event.type === "session.updated") {
    const title = text(record(event.properties.info)?.title)
    return title ? { payload: agentRuntimeEvent.sessionTitle({ title }) } : undefined
  }
  if (event.type === "session.agent") {
    const agentId = text(event.properties.agentId)
    return agentId ? { payload: agentRuntimeEvent.sessionAgent({ agentId }) } : undefined
  }
  if (event.type === "session.usage") {
    const contextSize = Number(event.properties.contextSize)
    const contextUsed = Number(event.properties.contextUsed)
    return {
      payload: agentRuntimeEvent.usage({
        contextSize: Number.isFinite(contextSize) ? contextSize : 0,
        contextUsed: Number.isFinite(contextUsed) ? contextUsed : 0,
        ...(record(event.properties.cost) ? { cost: event.properties.cost as { amount: number; currency: string } } : {}),
      }),
    }
  }
}
