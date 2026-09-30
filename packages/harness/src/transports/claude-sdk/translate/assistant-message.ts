import { asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import { own } from "../../../translate/value"
import { withoutKey, type ClaudeSdkAdapterState, type ClaudeTranslation } from "./adapter-state"
import { assistantBlocks, assistantSnapshotText, assistantToolBlocks } from "./assistant-content"
import { assistantErrorClass, windowLimitMessage } from "./rate-limits"
import { meterRequest } from "./request-usage"
import { diagnosticForEvent, type ClaudeFrameEvent, type ClaudeSdkAssistantMessage } from "./sdk-message"
import { claudeStreamOwner } from "./subagent-routing"
import { toolInputEvents, toolStartEvents } from "./tool-blocks"
import { isServerToolResult, serverToolResult } from "./tool-results"
import type { ClaudeTranslatorMemory } from "./translator-memory"

type AssistantError = NonNullable<ClaudeSdkAssistantMessage["error"]>
type Streamed = "streamedAssistantTextByOwner" | "streamedThinkingByOwner"
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

function assistantFailure(error: AssistantError, message: Record<string, unknown>, state: ClaudeSdkAdapterState): ClaudeTranslation {
  const errorClass = assistantErrorClass(error, state)
  const head = errorClass === "usage_limit" && state.rejectedWindow
    ? windowLimitMessage(state.rejectedWindow)
    : `Claude assistant message failed: ${error}`
  return { state: { ...state, failure: { error: [head, assistantSnapshotText(message)].filter(Boolean).join("\n"), ...(errorClass ? { errorClass } : {}) } }, events: [] }
}

function completeToolEvents(state: ClaudeSdkAdapterState, completeTools: ReturnType<typeof assistantToolBlocks>) {
  return completeTools.flatMap(({ block, tool }): AgentRuntimeEvent[] => {
    if (!own(state.toolsById, tool.toolCallId)) {
      return toolStartEvents(block)
    }
    return Object.keys(tool.input ?? {}).length ? toolInputEvents(tool, tool.input ?? {}) : []
  })
}

function reconcileKind(state: ClaudeSdkAdapterState, key: Streamed, owner: string, snapshot: string) {
  if (!snapshot) return { state, reconciliation: undefined, shown: "" }
  const shown = own(state[key], owner) ?? ""
  return { state: { ...state, [key]: withoutKey(state[key], owner) }, reconciliation: reconcileAssistantSnapshot(shown, snapshot), shown }
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

function serverResults(state: ClaudeSdkAdapterState, message: Record<string, unknown>) {
  let next = state
  const events = assistantBlocks(message).filter((block) => isServerToolResult(block.type)).flatMap((block) => {
    const settled = serverToolResult(next, block)
    if (Array.isArray(settled)) return settled
    next = settled.state ?? next
    return settled.events ?? []
  })
  return { state: next, events }
}

export function translateAssistantMessage(message: ClaudeSdkAssistantMessage, rawMessage: Record<string, unknown>, state: ClaudeSdkAdapterState,
  event: ClaudeFrameEvent, memory: ClaudeTranslatorMemory): ClaudeTranslation {
  if (message.error) return assistantFailure(message.error, rawMessage, state)
  const frameId = text(rawMessage.uuid)
  const repeated = frameId !== undefined && state.reconciledFrames?.[frameId] === true
  const completeTools = assistantToolBlocks(rawMessage)
  const messageId = text(message.message.id)
  const owner = claudeStreamOwner(rawMessage)
  const thinking = reconcileKind(state, "streamedThinkingByOwner", owner, repeated ? "" : assistantSnapshotText(rawMessage, "thinking"))
  const snapshot = repeated ? "" : assistantSnapshotText(rawMessage)
  const reply = reconcileKind(thinking.state, "streamedAssistantTextByOwner", owner, snapshot)
  const results = serverResults({ ...reply.state, ...(frameId ? { reconciledFrames: { ...state.reconciledFrames, [frameId]: true as const } } : {}), toolsById: { ...state.toolsById, ...Object.fromEntries(completeTools.map(({ tool }) => [tool.toolCallId, { ...own(state.toolsById, tool.toolCallId), ...tool }])) } }, rawMessage)
  const metered = messageId
    ? meterRequest(results.state, memory, owner, messageId, asRecord(message.message.usage), text(rawMessage.session_id), text(message.message.model))
    : undefined
  return {
    state: metered?.state ?? results.state,
    events: [
      ...completeToolEvents(state, completeTools),
      ...(thinking.reconciliation?.delta ? [{ type: "thinking-delta", delta: thinking.reconciliation.delta } satisfies AgentRuntimeEvent] : []),
      ...divergenceDiagnostics(reply.reconciliation, event, { messageId, shown: reply.shown, snapshot }),
      ...(reply.reconciliation?.delta ? [{ type: "text-delta", delta: reply.reconciliation.delta } satisfies AgentRuntimeEvent] : []),
      ...results.events,
      ...(metered ? [metered.event] : []),
    ],
  }
}
