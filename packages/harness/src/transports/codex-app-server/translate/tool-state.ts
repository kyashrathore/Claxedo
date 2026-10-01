import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { RETAINED_WIRE_KEYS_MAX, boundKeyedRecord, own } from "../../../translate/value"
import { toolNameForItem } from "./item-kind"
import { toolDisplayFromInput } from "../../../translate/tool-display"
import { withoutStreamedItem, type CodexAppServerAdapterState } from "./state"

function textContent(value: string) {
  return {
    type: "content",
    content: { type: "text", text: value },
  } satisfies Extract<AgentRuntimeEvent, { type: "tool-content" }>["content"]
}

export function withToolOutput(state: CodexAppServerAdapterState, toolCallId: string, output: string): CodexAppServerAdapterState {
  return {
    ...state,
    toolOutputByCallId: boundKeyedRecord({ ...state.toolOutputByCallId, [toolCallId]: output }, RETAINED_WIRE_KEYS_MAX),
  }
}

type ToolInput = {
  state: CodexAppServerAdapterState
  toolCallId: string
  itemType: string
  toolName?: string
  rawInput?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export function ensureTool(input: ToolInput) {
  const existing = own(input.state.toolsByItemId, input.toolCallId)
  const itemType = existing?.itemType ?? input.itemType
  const rawInput = existing?.input ?? input.rawInput
  const toolName = existing?.toolName ?? input.toolName ?? toolNameForItem(itemType, rawInput ?? {})
  const display = toolDisplayFromInput({ kind: itemType, input: rawInput, toolName })
  if (existing) return { state: input.state, events: [] satisfies AgentRuntimeEvent[], display }
  return openTool({ ...input, itemType, rawInput, toolName })
}

export function openTool(input: ToolInput & { toolName: string }) {
  const { itemType, rawInput, toolName } = input
  const display = toolDisplayFromInput({ kind: itemType, input: rawInput, toolName })
  const metadata = input.metadata ?? { codex: { itemType } }
  return {
    state: {
      ...withoutStreamedItem(input.state),
      toolsByItemId: boundKeyedRecord({
        ...input.state.toolsByItemId,
        [input.toolCallId]: { toolName, ...(rawInput ? { input: rawInput } : {}), itemType },
      }, RETAINED_WIRE_KEYS_MAX),
    },
    events: [
      { type: "tool-start", toolCallId: input.toolCallId, toolName, kind: itemType, display, metadata },
      ...(rawInput ? [{ type: "tool-input", toolCallId: input.toolCallId, input: rawInput, display, metadata } satisfies AgentRuntimeEvent] : []),
    ] satisfies AgentRuntimeEvent[],
    display,
  }
}

export function appendToolText(input: {
  state: CodexAppServerAdapterState
  toolCallId: string
  itemType: string
  delta: string | undefined
  metadata: Record<string, unknown>
}) {
  if (!input.delta) return { state: input.state, events: [] satisfies AgentRuntimeEvent[] }
  const ensured = ensureTool(input)
  const output = `${own(input.state.toolOutputByCallId, input.toolCallId) ?? ""}${input.delta}`
  return {
    state: withToolOutput(ensured.state, input.toolCallId, output),
    events: [
      ...ensured.events,
      { type: "tool-content", toolCallId: input.toolCallId, content: textContent(output), display: ensured.display, metadata: input.metadata },
    ] satisfies AgentRuntimeEvent[],
  }
}
