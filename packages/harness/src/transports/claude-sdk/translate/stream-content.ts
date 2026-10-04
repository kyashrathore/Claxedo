import { asText as text } from "@claxedo/agent-runtime-contract"
import { asRecord, asRecordOrEmpty as toolInput } from "@claxedo/helpers/guards"
import { own } from "../../../translate/value"
import type { ClaudeBlockState, ClaudeSdkAdapterState, ClaudeTranslation } from "./adapter-state"
import { parseJsonRecord, readPartialJsonRecord } from "./partial-json"
import { ignoredFrame, type ClaudeSdkStreamEvent } from "./sdk-message"
import { claudeStreamOwner } from "./subagent-routing"
import { toolInputEvents, toolStartEvents } from "./tool-blocks"
import { isServerToolResult, serverToolResult } from "./tool-results"
import type { ClaudeTranslatorMemory } from "./translator-memory"

type ContentBlockStart = Extract<ClaudeSdkStreamEvent, { type: "content_block_start" }>
type ContentBlockDelta = Extract<ClaudeSdkStreamEvent, { type: "content_block_delta" }>
type StartedBlock = ContentBlockStart["content_block"]
type ToolUseBlock = Extract<StartedBlock, { type: "tool_use" | "server_tool_use" | "mcp_tool_use" }>
const ignoredBlocks: readonly string[] = ["redacted_thinking", "container_upload", "compaction", "fallback"]
const ignoredDeltas: readonly string[] = ["citations_delta", "signature_delta", "compaction_delta"]

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

export function translateContentBlockStart(stream: ContentBlockStart, state: ClaudeSdkAdapterState, memory: ClaudeTranslatorMemory): ClaudeTranslation {
  const index = String(stream.index)
  const block = stream.content_block
  const kind: string = block.type
  if (isServerToolResult(kind)) return serverToolResult(state, asRecord(block) ?? {})
  if (ignoredBlocks.includes(kind)) return []
  switch (block.type) {
    case "text":
      return openBlock(state, index, { type: "text", fallbackText: text(block.text) })
    case "thinking":
      return openBlock(state, index, { type: "thinking", fallbackText: text(block.thinking) })
    case "tool_use":
    case "server_tool_use":
    case "mcp_tool_use":
      return openToolBlock(state, index, block)
    default:
      return ignoredFrame(memory, `content_block/${kind}`)
  }
}

function appendOwnerText(streamed: Record<string, string>, owner: string, delta: string) {
  return { ...streamed, [owner]: `${own(streamed, owner) ?? ""}${delta}` }
}

function markEmitted(state: ClaudeSdkAdapterState, index: string) {
  const block = state.blocksByIndex[index]
  return block ? { ...state.blocksByIndex, [index]: { ...block, emittedText: true } } : state.blocksByIndex
}

function contentDelta(state: ClaudeSdkAdapterState, index: string, delta: string | undefined, owner: string,
  kind: "text" | "thinking"): ClaudeTranslation {
  if (!delta) return []
  const key = kind === "text" ? "streamedAssistantTextByOwner" : "streamedThinkingByOwner"
  return {
    state: { ...state, [key]: appendOwnerText(state[key], owner, delta), blocksByIndex: markEmitted(state, index) },
    events: [{ type: kind === "text" ? "text-delta" : "thinking-delta", delta }],
  }
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
  memory: ClaudeTranslatorMemory,
): ClaudeTranslation {
  const index = String(stream.index)
  const row = stream.delta
  const kind: string = row.type
  if (ignoredDeltas.includes(kind)) return []
  switch (row.type) {
    case "text_delta":
      return contentDelta(state, index, text(row.text), claudeStreamOwner(message), "text")
    case "thinking_delta":
      return contentDelta(state, index, text(row.thinking), claudeStreamOwner(message), "thinking")
    case "input_json_delta":
      return inputJsonDelta(state, index, text(row.partial_json))
    default:
      return ignoredFrame(memory, `content_block_delta/${kind}`)
  }
}

export function translateContentBlockStop(index: string, message: Record<string, unknown>, state: ClaudeSdkAdapterState): ClaudeTranslation {
  const block = state.blocksByIndex[index]
  if (!block?.fallbackText || block.emittedText || block.type === "tool") return []
  return contentDelta(state, index, block.fallbackText, claudeStreamOwner(message), block.type)
}
