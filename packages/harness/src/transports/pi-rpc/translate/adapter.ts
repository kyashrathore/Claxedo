import type { HarnessEventAdapter } from "../../../translate/adapter"
import { asRecord } from "@claxedo/agent-runtime-contract"
import { piMessageEnd, piMessageStart, piMessageUpdate } from "./messages"
import { piAgentEnd, piAgentStart, piCompactionEnd, piCompactionStart, piExtensionError, piModelRetry, piSessionName, piSettled,
  piSummaryRetry } from "./session"
import { ignoredKind, initialPiState, piStep, type PiStep, type PiTranslatorState } from "./state"
import { piToolEnd, piToolStart, piToolUpdate } from "./tools"

type Handler = (state: PiTranslatorState, frame: Record<string, unknown>, sessionId: string) => PiStep

const HANDLERS: Record<string, Handler> = {
  agent_start: piAgentStart, agent_end: piAgentEnd, agent_settled: piSettled,
  message_start: piMessageStart, message_update: piMessageUpdate, message_end: piMessageEnd,
  tool_execution_start: piToolStart, tool_execution_update: piToolUpdate, tool_execution_end: piToolEnd,
  auto_retry_start: piModelRetry, summarization_retry_scheduled: piSummaryRetry,
  compaction_start: piCompactionStart, compaction_end: piCompactionEnd,
  session_info_changed: piSessionName, extension_error: piExtensionError,
  extension_ui_request: (state, frame) => ignoredKind(state, `extension_ui.${String(frame.method)}`),
}

const SILENT = ["turn_start", "turn_end", "queue_update", "entry_appended", "thinking_level_changed", "auto_retry_end",
  "summarization_retry_attempt_start", "summarization_retry_finished", "bash_execution_update"]

export function piRpcAdapter(): HarnessEventAdapter<PiTranslatorState> {
  return {
    name: "pi-rpc",
    createInitialState: initialPiState,
    translate({ state, event, context }) {
      const frame = asRecord(event.payload) ?? {}
      const type = String(frame.type)
      const handler = HANDLERS[type]
      if (handler) return handler(state, frame, context.threadId)
      return SILENT.includes(type) ? piStep(state) : ignoredKind(state, type)
    },
  }
}
