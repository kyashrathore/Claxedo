import { asText as text } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import { own } from "../../../translate/value"
import type { ClaudeBlockState, ClaudeSdkAdapterState, ClaudeTranslation } from "./adapter-state"
import { parseJsonRecord, readPartialJsonRecord } from "./partial-json"
import { assertNever, unmappedSdkEvent, type ClaudeFrameEvent, type ClaudeSdkStreamEvent } from "./sdk-message"
import { claudeStreamOwner } from "./subagent-routing"
import { toolInput, toolInputEvents, toolStartEvents } from "./tool-blocks"

type ContentBlockStart = Extract<ClaudeSdkStreamEvent, { type: "content_block_start" }>
type ContentBlockDelta = Extract<ClaudeSdkStreamEvent, { type: "content_block_delta" }>
type StartedBlock = ContentBlockStart["content_block"]
type ToolUseBlock = Extract<StartedBlock, { type: "tool_use" | "server_tool_use" | "mcp_tool_use" }>
type UnmappedBlockType = Exclude<StartedBlock["type"], "text" | "thinking" | ToolUseBlock["type"]>

const providerResultReason = "provider result block has no stable AgentRuntimeEvent mapping without a tool-use id"

const unmappedBlockReasons: Record<UnmappedBlockType, string> = {
  redacted_thinking: "redacted thinking cannot be represented as assistant thinking text",
  web_search_tool_result: providerResultReason,
  web_fetch_tool_result: providerResultReason,
  advisor_tool_result: providerResultReason,
  code_execution_tool_result: providerResultReason,
  bash_code_execution_tool_result: providerResultReason,
  text_editor_code_execution_tool_result: providerResultReason,
  tool_search_tool_result: providerResultReason,
  mcp_tool_result: providerResultReason,
  container_upload: providerResultReason,
  compaction: "streaming compaction content has no stable AgentRuntimeEvent mapping yet",
  fallback: "model fallback boundaries have no dedicated AgentRuntimeEvent equivalent",
}

function openBlock(state: ClaudeSdkAdapterState, index: string, block: ClaudeBlockState): ClaudeTranslation {
  return { state: { ...state, blocksByIndex: { ...state.blocksByIndex, [index]: block } }, events: [] }
}

function openToolBlock(state: ClaudeSdkAdapterState, index: string, block: ToolUseBlock): ClaudeTranslation {
  const blockRow = asRecord(block) ?? {}
  const toolName = text(block.name)
  const toolCallId = text(block.id)
  if (!toolName || !toolCallId) return []
  const input = toolInput(blockRow.input)
  const nextTool = {
    type: "tool" as const,
    toolCallId,
    toolName,
    input,
    partialInputJson: "",
  }
  return {
    state: {
      ...state,
      blocksByIndex: { ...state.blocksByIndex, [index]: nextTool },
      toolsById: { ...state.toolsById, [toolCallId]: nextTool },
    },
    events: toolStartEvents(blockRow),
  }
}

export function translateContentBlockStart(stream: ContentBlockStart, state: ClaudeSdkAdapterState, event: ClaudeFrameEvent): ClaudeTranslation {
  const index = String(stream.index)
  const block = stream.content_block
  switch (block.type) {
    case "text":
      return openBlock(state, index, { type: "text", fallbackText: text(block.text) })
    case "thinking":
      return openBlock(state, index, { type: "thinking", fallbackText: text(block.thinking) })
    case "tool_use":
    case "server_tool_use":
    case "mcp_tool_use":
      return openToolBlock(state, index, block)
    case "redacted_thinking":
    case "web_search_tool_result":
    case "web_fetch_tool_result":
    case "advisor_tool_result":
    case "code_execution_tool_result":
    case "bash_code_execution_tool_result":
    case "text_editor_code_execution_tool_result":
    case "tool_search_tool_result":
    case "mcp_tool_result":
    case "container_upload":
    case "compaction":
    case "fallback":
      return unmappedSdkEvent({
        sdkEvent: `SDKPartialAssistantMessage.content_block_start(${block.type})`,
        reason: unmappedBlockReasons[block.type],
        event,
      })
    default:
      return assertNever(block)
  }
}

function appendOwnerText(state: ClaudeSdkAdapterState, owner: string, delta: string) {
  return { ...state.streamedAssistantTextByOwner, [owner]: `${own(state.streamedAssistantTextByOwner, owner) ?? ""}${delta}` }
}

function markEmitted(state: ClaudeSdkAdapterState, index: string) {
  const block = state.blocksByIndex[index]
  return block ? { ...state.blocksByIndex, [index]: { ...block, emittedText: true } } : state.blocksByIndex
}

function textDelta(state: ClaudeSdkAdapterState, index: string, deltaText: string | undefined, owner: string): ClaudeTranslation {
  if (!deltaText) return []
  return {
    state: { ...state, streamedAssistantTextByOwner: appendOwnerText(state, owner, deltaText), blocksByIndex: markEmitted(state, index) },
    events: [{ type: "text-delta", delta: deltaText }],
  }
}

function thinkingDelta(state: ClaudeSdkAdapterState, index: string, thinking: string | undefined): ClaudeTranslation {
  if (!thinking) return []
  return { state: { ...state, blocksByIndex: markEmitted(state, index) }, events: [{ type: "thinking-delta", delta: thinking }] }
}

function inputJsonDelta(state: ClaudeSdkAdapterState, index: string, partial: string | undefined): ClaudeTranslation {
  const block = state.blocksByIndex[index]
  if (!block || block.type !== "tool" || !partial) return []
  const partialInputJson = `${block.partialInputJson ?? ""}${partial}`
  const parsedInput = parseJsonRecord(partialInputJson)
  const streamedInput = parsedInput ?? readPartialJsonRecord(partialInputJson)
  const streamedInputJson = streamedInput && Object.keys(streamedInput).length > 0
    ? JSON.stringify(streamedInput)
    : undefined
  const emit = streamedInput && streamedInputJson && streamedInputJson !== block.streamedInputJson
  const nextBlock = {
    ...block,
    partialInputJson,
    ...(parsedInput ? { input: parsedInput } : {}),
    ...(emit ? { streamedInputJson } : {}),
  }
  return {
    state: { ...state, blocksByIndex: { ...state.blocksByIndex, [index]: nextBlock } },
    events: emit ? toolInputEvents(nextBlock, streamedInput) : [],
  }
}

export function translateContentBlockDelta(
  stream: ContentBlockDelta,
  message: Record<string, unknown>,
  state: ClaudeSdkAdapterState,
  event: ClaudeFrameEvent,
): ClaudeTranslation {
  const index = String(stream.index)
  const row = stream.delta
  switch (row.type) {
    case "text_delta":
      return textDelta(state, index, text(row.text), claudeStreamOwner(message))
    case "thinking_delta":
      return thinkingDelta(state, index, text(row.thinking))
    case "input_json_delta":
      return inputJsonDelta(state, index, text(row.partial_json))
    case "citations_delta":
    case "signature_delta":
    case "compaction_delta":
      return unmappedSdkEvent({
        sdkEvent: `SDKPartialAssistantMessage.content_block_delta(${row.type})`,
        reason: "delta type has no dedicated AgentRuntimeEvent equivalent",
        event,
      })
    default:
      return assertNever(row)
  }
}

export function translateContentBlockStop(index: string, message: Record<string, unknown>, state: ClaudeSdkAdapterState): ClaudeTranslation {
  const block = state.blocksByIndex[index]
  if (block?.type === "text" && block.fallbackText && !block.emittedText) {
    return {
      state: {
        ...state,
        streamedAssistantTextByOwner: appendOwnerText(state, claudeStreamOwner(message), block.fallbackText),
        blocksByIndex: markEmitted(state, index),
      },
      events: [{ type: "text-delta", delta: block.fallbackText }],
    }
  }
  if (block?.type === "thinking" && block.fallbackText && !block.emittedText) {
    return { state: { ...state, blocksByIndex: markEmitted(state, index) }, events: [{ type: "thinking-delta", delta: block.fallbackText }] }
  }
  return []
}
