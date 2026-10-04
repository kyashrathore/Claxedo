import type { SDKMessage } from "@cursor/sdk"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { asRecord, isRecord } from "@claxedo/helpers/guards"
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
  return message.message.content.reduce((current, block) => {
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

type SdkMessages = { [Kind in SDKMessage["type"]]: Extract<SDKMessage, { type: Kind }> }

const nothingRequired = () => true

const sdkMessageShapes: { [Kind in keyof SdkMessages]: (row: Record<string, unknown>) => boolean } = {
  assistant: (row) => {
    const content = asRecord(row.message)?.content
    return Array.isArray(content) && content.every((block) => {
      const item = asRecord(block)
      return !!item && (item.type === "text" || (typeof item.name === "string" && typeof item.id === "string"))
    })
  },
  thinking: nothingRequired,
  tool_call: (row) => typeof row.call_id === "string" && typeof row.name === "string",
  status: (row) => typeof row.status === "string",
  usage: (row) => typeof row.run_id === "string" && isRecord(row.usage),
  task: nothingRequired,
  system: nothingRequired,
  request: nothingRequired,
  user: nothingRequired,
}

function isSdkMessage(row: Record<string, unknown>): row is Record<string, unknown> & SDKMessage {
  const shape = typeof row.type === "string" ? own(sdkMessageShapes, row.type) : undefined
  return !!shape && shape(row)
}

const sdkMessageProtocolMap: { [Kind in keyof SdkMessages]: (state: CursorSdkAdapterState, message: SdkMessages[Kind]) => CursorTranslation } = {
  assistant: assistantEvents,
  thinking: (state, message) => unchanged(state, message.text ? [{ type: "thinking-delta", delta: message.text }] : []),
  tool_call: toolCallEvents,
  status: statusEvents,
  usage: summedUsageEvents,
  task: compactionEvents,
  system: (state) => unchanged(state),
  request: (state) => unchanged(state),
  user: (state) => unchanged(state),
}

function translateMessageKind<Kind extends keyof SdkMessages>(state: CursorSdkAdapterState, kind: Kind, message: SdkMessages[Kind]): CursorTranslation {
  return sdkMessageProtocolMap[kind](state, message)
}

export function translateSdkMessage(state: CursorSdkAdapterState, row: Record<string, unknown>, unknownType = String(row.type)): CursorTranslation {
  return isSdkMessage(row) ? translateMessageKind(state, row.type, row) : unknownKind(state, `message:${unknownType}`)
}
