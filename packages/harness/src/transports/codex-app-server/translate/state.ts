import type { HarnessEventAdapterContext } from "../../../translate/adapter"
import { threadOf } from "./frame"

export type CodexTurnUsageState = {
  turnId?: string
  model?: string
  scope?: string
  previousTotals?: Record<string, unknown>
  previousTotalsSignature?: string
  accumulated: {
    inputTokens: number | null
    cachedInputTokens: number | null
    outputTokens: number | null
    reasoningOutputTokens: number | null
  }
}

export type CodexAppServerAdapterState = {
  assistantTextByItemId: Record<string, string>
  toolOutputByCallId: Record<string, string>
  toolsByItemId: Record<string, {
    toolName: string
    input?: Record<string, unknown>
    itemType?: string
  }>
  turnUsageByThread?: Record<string, CodexTurnUsageState>
  reasoningTextByItemId?: Record<string, string>
  reportedModels?: Record<string, string>
  lastLimitedRateLimitMessage?: string
  streamedItem?: { channel: "text" | "reasoning"; itemId: string }
}

export function createCodexAppServerAdapterState(): CodexAppServerAdapterState {
  return { assistantTextByItemId: {}, toolOutputByCallId: {}, toolsByItemId: {} }
}

function pruneTurnState(state?: CodexAppServerAdapterState): CodexAppServerAdapterState {
  return {
    ...createCodexAppServerAdapterState(),
    ...(state?.lastLimitedRateLimitMessage
      ? { lastLimitedRateLimitMessage: state.lastLimitedRateLimitMessage }
      : {}),
  }
}

export function endThreadTurn(
  state: CodexAppServerAdapterState,
  event: { payload: unknown },
  context: HarnessEventAdapterContext,
): CodexAppServerAdapterState {
  const threadId = threadOf(event, context)
  if (threadId === context.threadId) return pruneTurnState(state)
  const { [threadId]: _ended, ...turnUsageByThread } = state.turnUsageByThread ?? {}
  return { ...state, turnUsageByThread }
}

export function withoutStreamedItem(state: CodexAppServerAdapterState): CodexAppServerAdapterState {
  const { streamedItem: _streamedItem, ...rest } = state
  return rest
}
