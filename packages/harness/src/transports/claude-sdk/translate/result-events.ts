import { asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent, AgentRuntimeEventOf } from "@claxedo/agent-runtime-contract"
import type { HarnessEventAdapterContext } from "../../../translate/adapter"
import type { ClaudeSdkAdapterState, ClaudeTranslation } from "./adapter-state"
import { resultContextWindow, resultUsageEvent } from "./request-usage"

function isInterruptedResult(message: Record<string, unknown>, errorMessage?: string) {
  const summary = [
    errorMessage,
    text(message.subtype),
    text(message.stop_reason),
    text(message.result),
  ].flatMap((item) => item ?? []).join(" ").toLowerCase()
  return ["request was aborted", "aborted", "cancelled", "canceled", "interrupted"].some((item) => summary.includes(item))
}

function resultEvents(
  message: Record<string, unknown>,
  context: HarnessEventAdapterContext,
  usage: AgentRuntimeEventOf<"usage"> | undefined,
) {
  const sessionId = text(message.session_id) ?? context.threadId
  const errors = Array.isArray(message.errors)
    ? message.errors.filter((item): item is string => typeof item === "string")
    : []
  const errorMessage = errors[0] ?? text(message.error)
  const interrupted = isInterruptedResult(message, errorMessage)
  if (message.is_error === true && !interrupted) {
    return [
      ...(usage ? [usage] : []),
      { type: "session-status", status: "error" },
      { type: "error", error: errorMessage ?? "Claude turn failed" },
    ] satisfies AgentRuntimeEvent[]
  }
  if (interrupted) {
    return [
      ...(usage ? [usage] : []),
      { type: "session-status", status: "idle" },
      { type: "cancelled", sessionId },
    ] satisfies AgentRuntimeEvent[]
  }
  return [
    ...(usage ? [usage] : []),
    { type: "session-status", status: "idle" },
    { type: "finish", sessionId },
  ] satisfies AgentRuntimeEvent[]
}

export function translateResult(state: ClaudeSdkAdapterState, message: Record<string, unknown>, context: HarnessEventAdapterContext): ClaudeTranslation {
  const lastKnownContextWindow = resultContextWindow(message) ?? state.lastKnownContextWindow
  const next = {
    ...state,
    blocksByIndex: {},
    toolsById: {},
    streamedAssistantTextByOwner: {},
    reconciledAssistantTextByMessageId: {},
    ...(lastKnownContextWindow ? { lastKnownContextWindow } : {}),
  }
  return {
    state: next,
    events: resultEvents(message, context, resultUsageEvent(next, text(message.session_id))),
  }
}
