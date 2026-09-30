import { asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { HarnessEventAdapterResult } from "../../../translate/adapter"
import { RETAINED_WIRE_KEYS_MAX, boundKeyedRecord, own } from "../../../translate/value"
import { eventText, itemId, type CodexHandler, type CodexHandlers } from "./frame"
import type { CodexAppServerAdapterState } from "./state"

type Result = HarnessEventAdapterResult<CodexAppServerAdapterState> | AgentRuntimeEvent[]

function streamedReasoning(state: CodexAppServerAdapterState, id: string, delta: string) {
  const reasoningTextByItemId = boundKeyedRecord({
    ...state.reasoningTextByItemId,
    [id]: `${own(state.reasoningTextByItemId ?? {}, id) ?? ""}${delta}`,
  }, RETAINED_WIRE_KEYS_MAX)
  return { state: { ...state, reasoningTextByItemId }, events: [{ type: "thinking-delta" as const, delta }] }
}

const reasoningDelta: CodexHandler = ({ state, event }) => {
  const delta = eventText(event)
  return delta ? streamedReasoning(state, itemId(event, "reasoning"), delta) : []
}

export function completedAssistantMessage(state: CodexAppServerAdapterState, id: string, completed: Record<string, unknown>): Result {
  const fullText = text(completed.text)
  const previous = own(state.assistantTextByItemId, id) ?? ""
  const delta = fullText?.startsWith(previous) ? fullText.slice(previous.length) : fullText
  if (!delta) return []
  return {
    state: {
      ...state,
      assistantTextByItemId: boundKeyedRecord({ ...state.assistantTextByItemId, [id]: fullText ?? previous }, RETAINED_WIRE_KEYS_MAX),
    },
    events: [{ type: "text-delta", delta }],
  }
}

export function completedReasoning(state: CodexAppServerAdapterState, id: string, completed: Record<string, unknown>): Result {
  if (own(state.reasoningTextByItemId ?? {}, id)) return []
  const content = [
    text(completed.text),
    text(completed.summary),
    ...(Array.isArray(completed.content) ? completed.content.flatMap((item) => text(item) ?? []) : []),
    ...(Array.isArray(completed.summary) ? completed.summary.flatMap((item) => text(item) ?? []) : []),
  ].flatMap((item) => item ?? []).join("\n")
  return content ? [{ type: "thinking-delta", delta: content }] : []
}

export const messageHandlers: CodexHandlers = {
  "item/agentMessage/delta": ({ state, event }) => {
    const delta = eventText(event)
    if (!delta) return []
    const id = itemId(event, "assistant")
    return {
      state: {
        ...state,
        assistantTextByItemId: boundKeyedRecord({
          ...state.assistantTextByItemId,
          [id]: `${own(state.assistantTextByItemId, id) ?? ""}${delta}`,
        }, RETAINED_WIRE_KEYS_MAX),
      },
      events: [{ type: "text-delta", delta }],
    }
  },
  "item/reasoning/textDelta": reasoningDelta,
  "item/reasoning/summaryTextDelta": reasoningDelta,
  "item/reasoning/summaryPartAdded": ({ state, event }) => {
    const streamed = own(state.reasoningTextByItemId ?? {}, itemId(event, "reasoning")) ?? ""
    return streamed && !streamed.endsWith("\n\n") ? streamedReasoning(state, itemId(event, "reasoning"), "\n\n") : []
  },
  "item/plan/delta": ({ event }) => {
    const delta = eventText(event)
    return delta ? [{ type: "proposed-plan-delta", delta }] : []
  },
}
