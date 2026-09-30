import { asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import { own } from "../../../translate/value"
import { withoutKey, type ClaudeSdkAdapterState, type ClaudeTranslation } from "./adapter-state"
import { assistantSnapshotText, assistantToolBlocks } from "./assistant-content"
import { assistantErrorClass, windowLimitMessage } from "./rate-limits"
import { meterRequest } from "./request-usage"
import { diagnosticForEvent, type ClaudeFrameEvent, type ClaudeSdkAssistantMessage } from "./sdk-message"
import { claudeStreamOwner } from "./subagent-routing"
import { toolInputEvents, toolStartEvents } from "./tool-blocks"

type AssistantError = NonNullable<ClaudeSdkAssistantMessage["error"]>
type SnapshotReconciliation = { delta: string; divergedAt?: number }

function commonPrefixLength(shown: string, snapshot: string) {
  const limit = Math.min(shown.length, snapshot.length)
  let shared = 0
  while (shared < limit && shown[shared] === snapshot[shared]) shared += 1
  return shared
}

function reconcileAssistantSnapshot(shown: string, snapshot: string): SnapshotReconciliation {
  if (snapshot.startsWith(shown)) return { delta: snapshot.slice(shown.length) }
  const shared = commonPrefixLength(shown, snapshot)
  return { delta: snapshot.slice(shared), divergedAt: shared }
}

function assistantErrorEvents(error: AssistantError, message: Record<string, unknown>, state: ClaudeSdkAdapterState): AgentRuntimeEvent[] {
  const explanation = assistantSnapshotText(message)
  const errorClass = assistantErrorClass(error, state)
  const head = errorClass === "usage_limit" && state.rejectedWindow
    ? windowLimitMessage(state.rejectedWindow)
    : `Claude assistant message failed: ${error}`
  return [
    { type: "session-status", status: "error" },
    {
      type: "error",
      error: [head, explanation].filter(Boolean).join("\n"),
      ...(errorClass ? { errorClass } : {}),
    },
  ] satisfies AgentRuntimeEvent[]
}

function completeToolEvents(state: ClaudeSdkAdapterState, completeTools: ReturnType<typeof assistantToolBlocks>) {
  return completeTools.flatMap(({ block, tool }): AgentRuntimeEvent[] => {
    if (!own(state.toolsById, tool.toolCallId)) {
      return toolStartEvents(block)
    }
    return Object.keys(tool.input ?? {}).length ? toolInputEvents(tool, tool.input ?? {}) : []
  })
}

function reconciledTextState(state: ClaudeSdkAdapterState, owner: string, messageId: string | undefined, snapshot: string) {
  return {
    streamedAssistantTextByOwner: withoutKey(state.streamedAssistantTextByOwner, owner),
    ...(messageId
      ? { reconciledAssistantTextByMessageId: { ...state.reconciledAssistantTextByMessageId, [messageId]: snapshot } }
      : {}),
  }
}

function divergenceDiagnostics(
  reconciliation: SnapshotReconciliation | undefined,
  event: ClaudeFrameEvent,
  compared: { messageId: string | undefined; shown: string; snapshot: string },
): AgentRuntimeEvent[] {
  if (reconciliation?.divergedAt === undefined) return []
  return [diagnosticForEvent({
    code: "claude_sdk.assistant_snapshot_divergence",
    message: "assistant snapshot diverges from the streamed text; emitting only the unseen suffix",
    severity: "warn",
    event,
    details: {
      ...(compared.messageId ? { messageId: compared.messageId } : {}),
      divergedAt: reconciliation.divergedAt,
      shownLength: compared.shown.length,
      snapshotLength: compared.snapshot.length,
    },
  })]
}

export function translateAssistantMessage(
  message: ClaudeSdkAssistantMessage,
  rawMessage: Record<string, unknown>,
  state: ClaudeSdkAdapterState,
  event: ClaudeFrameEvent,
): ClaudeTranslation {
  if (message.error) return assistantErrorEvents(message.error, rawMessage, state)
  const completeTools = assistantToolBlocks(rawMessage)
  const snapshot = assistantSnapshotText(rawMessage)
  const messageId = text(message.message.id)
  const owner = claudeStreamOwner(rawMessage)
  const shown = `${(messageId ? own(state.reconciledAssistantTextByMessageId, messageId) : undefined) ?? ""}${own(state.streamedAssistantTextByOwner, owner) ?? ""}`
  const reconciliation = snapshot ? reconcileAssistantSnapshot(shown, snapshot) : undefined
  const metered = messageId
    ? meterRequest(state, owner, messageId, asRecord(message.message.usage), text(rawMessage.session_id), text(message.message.model))
    : undefined
  return {
    state: {
      ...state,
      toolsById: { ...state.toolsById, ...Object.fromEntries(completeTools.map(({ tool }) => [tool.toolCallId, tool])) },
      ...(reconciliation ? reconciledTextState(state, owner, messageId, snapshot) : {}),
      ...(metered ? { requestUsageByOwner: metered.requestUsageByOwner } : {}),
    },
    events: [
      ...completeToolEvents(state, completeTools),
      ...divergenceDiagnostics(reconciliation, event, { messageId, shown, snapshot }),
      ...(reconciliation?.delta ? [{ type: "text-delta", delta: reconciliation.delta } satisfies AgentRuntimeEvent] : []),
      ...(metered ? [metered.event] : []),
    ],
  }
}
