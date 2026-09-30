import type { SDKMessage } from "@cursor/sdk"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { unknownKind } from "./frames"
import { statusEvents } from "./run-status"
import { unchanged, type CursorSdkAdapterState, type CursorTranslation } from "./state"
import { toolCompletedEvents } from "./tool-results"
import { cursorToolName, ensureTool, isTodoTool, todosFromInput, toolInput } from "./tools"
import { usageEvents } from "./usage"

type Assistant = Extract<SDKMessage, { type: "assistant" }>
type ToolCall = Extract<SDKMessage, { type: "tool_call" }>

function todoEvents(input: Record<string, unknown>): AgentRuntimeEvent[] {
  const todos = todosFromInput(input)
  return todos.length ? [{ type: "todo-update", todos }] : []
}

function assistantEvents(state: CursorSdkAdapterState, message: Assistant): CursorTranslation {
  return message.message.content.reduce<CursorTranslation>((current, block) => {
    if (block.type === "text") return block.text ? unchanged(current.state, [...current.events, { type: "text-delta", delta: block.text }]) : current
    const input = toolInput(block.input)
    if (isTodoTool(block.name)) return unchanged(current.state, [...current.events, ...todoEvents(input)])
    const ensured = ensureTool({ state: current.state, toolCallId: block.id, toolName: cursorToolName(block.name, input), rawInput: input })
    return { state: ensured.state, events: [...current.events, ...ensured.events] }
  }, unchanged(state))
}

function toolCallEvents(state: CursorSdkAdapterState, message: ToolCall): CursorTranslation {
  const rawInput = toolInput(message.args)
  const toolName = cursorToolName(message.name, rawInput)
  if (isTodoTool(toolName)) return unchanged(state, todoEvents(rawInput))
  const status = message.status
  switch (status) {
    case "running": {
      const ensured = ensureTool({ state, toolCallId: message.call_id, toolName, rawInput })
      return { state: ensured.state, events: [...ensured.events, { type: "tool-status", toolCallId: message.call_id, status: "running",
        display: ensured.display, metadata: { cursor: { itemType: ensured.kind, truncated: message.truncated } } }] }
    }
    case "completed":
    case "error":
      return toolCompletedEvents({ state, toolCallId: message.call_id, toolName, rawInput, result: message.result, isError: status === "error" })
    default:
      return unknownKind(state, `tool_call:${String(status)}`)
  }
}

function compactionEvents(state: CursorSdkAdapterState, message: Extract<SDKMessage, { type: "task" }>): CursorTranslation {
  const summary = text(message.text)
  return unchanged(state, summary ? [{ type: "session-compaction", phase: "completed", summary }] : [])
}

export function translateSdkMessage(state: CursorSdkAdapterState, message: SDKMessage): CursorTranslation {
  switch (message.type) {
    case "assistant":
      return assistantEvents(state, message)
    case "thinking":
      return unchanged(state, message.text ? [{ type: "thinking-delta", delta: message.text }] : [])
    case "tool_call":
      return toolCallEvents(state, message)
    case "status":
      return statusEvents(state, message)
    case "usage":
      return usageEvents(state, message)
    case "task":
      return compactionEvents(state, message)
    case "system":
    case "request":
    case "user":
      return unchanged(state)
    default:
      return unknownKind(state, `message:${String((message as { type: unknown }).type)}`)
  }
}
