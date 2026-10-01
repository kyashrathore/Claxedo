import type { SDKMessage } from "@cursor/sdk"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { own } from "../../../translate/value"
import { unknownKind } from "./frames"
import { statusEvents } from "./run-status"
import { closedShell, openedShell } from "./shell-output"
import { unchanged, type CursorSdkAdapterState, type CursorTranslation } from "./state"
import { toolCompletedEvents } from "./tool-results"
import { cursorToolName, ensureTool, isTodoTool, todosFromInput, toolInput } from "./tools"
import { summedUsageEvents } from "./usage"

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
      return { state: toolName === "shell" ? openedShell(ensured.state, message.call_id) : ensured.state, events: [...ensured.events, { type: "tool-status",
        toolCallId: message.call_id, status: "running", display: ensured.display, metadata: { cursor: { itemType: ensured.kind, truncated: message.truncated } } }] }
    }
    case "completed":
    case "error":
      return toolCompletedEvents({ state: closedShell(state, message.call_id), toolCallId: message.call_id, toolName, rawInput, result: message.result,
        isError: status === "error" })
    default:
      return unknownKind(state, `tool_call:${String(status)}`)
  }
}

function compactionEvents(state: CursorSdkAdapterState, message: Extract<SDKMessage, { type: "task" }>): CursorTranslation {
  const summary = text(message.text)
  return unchanged(state, summary ? [{ type: "session-compaction", phase: "completed", summary }] : [])
}

const sdkMessageProtocolMap = {
  assistant: assistantEvents,
  thinking: (state, message) => unchanged(state, message.text ? [{ type: "thinking-delta", delta: message.text }] : []),
  tool_call: toolCallEvents,
  status: statusEvents,
  usage: summedUsageEvents,
  task: compactionEvents,
  system: (state) => unchanged(state),
  request: (state) => unchanged(state),
  user: (state) => unchanged(state),
} satisfies { [Kind in SDKMessage["type"]]: (state: CursorSdkAdapterState, message: Extract<SDKMessage, { type: Kind }>) => CursorTranslation }

export function translateSdkMessage(state: CursorSdkAdapterState, row: Record<string, unknown>, unknownType = String(row.type)): CursorTranslation {
  const handlers = sdkMessageProtocolMap as Record<string, (state: CursorSdkAdapterState, message: SDKMessage) => CursorTranslation>
  const translate = typeof row.type === "string" ? own(handlers, row.type) : undefined
  return translate ? translate(state, row as unknown as SDKMessage) : unknownKind(state, `message:${unknownType}`)
}
