import { asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { HarnessEventAdapterResult } from "../../../translate/adapter"
import { RETAINED_WIRE_KEYS_MAX, boundKeyedRecord, own } from "../../../translate/value"
import { eventText, itemId, type CodexHandler, type CodexHandlers } from "./frame"
import type { CodexAppServerAdapterState } from "./state"

type Result = HarnessEventAdapterResult<CodexAppServerAdapterState> | AgentRuntimeEvent[]
type Channel = "text" | "reasoning"

function separated(state: CodexAppServerAdapterState, channel: Channel, itemId: string, delta: string) {
  const previous = state.streamedItem
  const paragraph = previous?.channel === channel && previous.itemId !== itemId ? "\n\n" : ""
  return { state: { ...state, streamedItem: { channel, itemId } }, delta: `${paragraph}${delta}` }
}

function streamedMessage(state: CodexAppServerAdapterState, channel: Channel, id: string, delta: string) {
  const key = channel === "text" ? "assistantTextByItemId" : "reasoningTextByItemId"
  const accumulated = boundKeyedRecord({
    ...state[key],
    [id]: `${own(state[key] ?? {}, id) ?? ""}${delta}`,
  }, RETAINED_WIRE_KEYS_MAX)
  const shown = separated({ ...state, [key]: accumulated }, channel, id, delta)
  return { state: shown.state, events: [{ type: channel === "text" ? "text-delta" as const : "thinking-delta" as const, delta: shown.delta }] }
}

function messageDelta(channel: Channel, prefix: string): CodexHandler {
  return ({ state, event }) => {
    const delta = eventText(event)
    return delta ? streamedMessage(state, channel, itemId(event, prefix), delta) : []
  }
}

export function completedAssistantMessage(state: CodexAppServerAdapterState, id: string, completed: Record<string, unknown>): Result {
  const fullText = text(completed.text)
  const previous = own(state.assistantTextByItemId, id) ?? ""
  const delta = fullText?.startsWith(previous) ? fullText.slice(previous.length) : fullText
  if (!delta) return []
  const shown = separated({
    ...state,
    assistantTextByItemId: boundKeyedRecord({ ...state.assistantTextByItemId, [id]: fullText ?? previous }, RETAINED_WIRE_KEYS_MAX),
  }, "text", id, delta)
  return { state: shown.state, events: [{ type: "text-delta", delta: shown.delta }] }
}

export function completedReasoning(state: CodexAppServerAdapterState, id: string, completed: Record<string, unknown>): Result {
  if (own(state.reasoningTextByItemId ?? {}, id)) return []
  const content = [
    text(completed.text),
    text(completed.summary),
    ...(Array.isArray(completed.content) ? completed.content.flatMap((item) => text(item) ?? []) : []),
    ...(Array.isArray(completed.summary) ? completed.summary.flatMap((item) => text(item) ?? []) : []),
  ].flatMap((item) => item ?? []).join("\n")
  if (!content) return []
  const shown = separated(state, "reasoning", id, content)
  return { state: shown.state, events: [{ type: "thinking-delta", delta: shown.delta }] }
}

export const messageHandlers: CodexHandlers = {
  "item/agentMessage/delta": messageDelta("text", "assistant"),
  "item/reasoning/textDelta": messageDelta("reasoning", "reasoning"),
  "item/reasoning/summaryTextDelta": messageDelta("reasoning", "reasoning"),
  "item/reasoning/summaryPartAdded": ({ state, event }) => {
    const streamed = own(state.reasoningTextByItemId ?? {}, itemId(event, "reasoning")) ?? ""
    return streamed && !streamed.endsWith("\n\n") ? streamedMessage(state, "reasoning", itemId(event, "reasoning"), "\n\n") : []
  },
  "item/plan/delta": ({ event }) => {
    const delta = eventText(event)
    return delta ? [{ type: "proposed-plan-delta", delta }] : []
  },
}
