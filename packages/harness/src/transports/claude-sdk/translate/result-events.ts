import { asText as text, type AgentRuntimeEvent, type AgentRuntimeEventOf } from "@claxedo/agent-runtime-contract"
import type { HarnessEventAdapterContext } from "../../../translate/adapter"
import type { ClaudeSdkAdapterState, ClaudeTranslation } from "./adapter-state"
import { rememberContextWindow, resultUsageEvent } from "./request-usage"
import type { ClaudeTranslatorMemory } from "./translator-memory"

const cancelledReasons: readonly string[] = ["aborted_streaming", "aborted_tools"]

function resultFailure(message: Record<string, unknown>, state: ClaudeSdkAdapterState): AgentRuntimeEvent {
  if (state.failure) return { type: "error", ...state.failure }
  const errors = Array.isArray(message.errors) ? message.errors.filter((item): item is string => typeof item === "string") : []
  return { type: "error", error: errors[0] ?? text(message.result) ?? "Claude turn failed" }
}

function resultEvents(message: Record<string, unknown>, state: ClaudeSdkAdapterState, context: HarnessEventAdapterContext,
  usage: AgentRuntimeEventOf<"usage"> | undefined): AgentRuntimeEvent[] {
  const sessionId = text(message.session_id) ?? context.threadId
  const metered = usage ? [usage] : []
  if (cancelledReasons.includes(text(message.terminal_reason) ?? "")) return [...metered, { type: "session-status", status: "idle" }, { type: "cancelled", sessionId }]
  if (message.is_error === true) return [...metered, { type: "session-status", status: "error" }, resultFailure(message, state)]
  return [...metered, { type: "session-status", status: "idle" }, { type: "finish", sessionId }]
}

export function translateResult(state: ClaudeSdkAdapterState, message: Record<string, unknown>, context: HarnessEventAdapterContext,
  memory: ClaudeTranslatorMemory): ClaudeTranslation {
  rememberContextWindow(state, memory, message)
  const { failure: _, reconciledFrames: __, ...settled } = state
  return {
    state: { ...settled, blocksByIndex: {}, toolsById: {}, streamedAssistantTextByOwner: {}, streamedThinkingByOwner: {} },
    events: resultEvents(message, state, context, resultUsageEvent(state, memory, text(message.session_id))),
  }
}
