import type { Message } from "@opencode-ai/sdk/v2"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import {
  sessionTurnOutcomeMatchesAssistant,
  type ClaxedoSession,
  type SessionTurnOutcome,
} from "../data/session-types"

type Snapshot<T> = {
  sessionKey: string
  value: T | undefined
}

export function stableSessionInfo(
  prev: Snapshot<ClaxedoSession> | undefined,
  sessionKey: string | undefined,
  next: ClaxedoSession | undefined,
): Snapshot<ClaxedoSession> | undefined {
  if (!isRealSessionKey(sessionKey)) return undefined
  if (next) return { sessionKey, value: next }
  if (prev?.sessionKey === sessionKey) return prev
  return undefined
}

export function stableSessionMessages(
  prev: Snapshot<Message[]> | undefined,
  sessionKey: string | undefined,
  next: Message[] | undefined,
): Snapshot<Message[]> | undefined {
  if (!isRealSessionKey(sessionKey)) return undefined
  if (next !== undefined) return { sessionKey, value: next }
  if (prev?.sessionKey === sessionKey) return prev
  return { sessionKey, value: undefined }
}

export function sessionUserMessages(messages: Message[]) {
  return messages.filter((message): message is UserMessage => message.role === "user")
}

export function visibleSessionUserMessages(input: {
  userMessages: UserMessage[]
  revertMessageId?: string
}) {
  if (!input.revertMessageId) return input.userMessages
  return input.userMessages.filter((message) => message.id < input.revertMessageId!)
}

function isRealSessionKey(sessionKey: string | undefined): sessionKey is string {
  return !!sessionKey && (sessionKey.startsWith("session:") || sessionKey.includes(":session:"))
}

export function shouldReconcileBusySessionToIdle(input: {
  lastTurn?: SessionTurnOutcome
  assistantMessageId?: string
}) {
  return sessionTurnOutcomeMatchesAssistant({
    outcome: input.lastTurn,
    assistantMessageId: input.assistantMessageId,
  })
}

export function staleBusyReconciliationKey(input: {
  sessionId: string | undefined
  statusType: string | undefined
  stale: boolean
  blocked: boolean
  assistantMessageId?: string
  lastTurn?: SessionTurnOutcome
}) {
  if (!input.sessionId || input.statusType !== "busy" || !input.stale || input.blocked) return undefined
  if (!input.assistantMessageId) return undefined
  return `${input.sessionId}:${input.assistantMessageId}`
}

export function shouldDispatchIdleAfterStaleBusyRefresh(input: {
  statusType: string | undefined
}) {
  return input.statusType !== "busy" && input.statusType !== "retry"
}

export function sessionMessagesReady(input: {
  sessionId: string | undefined
  sessionMissing: boolean
  messagesLoaded: boolean
}) {
  if (!input.sessionId) return true
  if (input.sessionMissing) return true
  return input.messagesLoaded
}

export function sessionFirstFoldReady(input: {
  sessionId: string | undefined
  sessionMissing: boolean
  hasSessionInfo: boolean
  hasInventorySession: boolean
  messagesReady: boolean
}) {
  if (!input.sessionId || input.sessionId === "new") return true
  if (input.sessionMissing) return true
  return input.hasSessionInfo || input.hasInventorySession || input.messagesReady
}

export function shouldRenderNewSessionComposer(input: {
  workspaceId: string | undefined
  workspaceReady: boolean
}) {
  if (!input.workspaceId) return true
  return input.workspaceReady
}

export function timelineInteractionPlan(input: {
  prependLoading: boolean
  hasScrollGesture: boolean
}) {
  return {
    prepareOverscan: true,
    clearPrependAnchor: !input.prependLoading,
    yieldToUserScroll: input.hasScrollGesture,
  }
}

export function timelineInitialRenderOverscan(input: {
  cachedMeasurementCount: number
}) {
  return input.cachedMeasurementCount > 0 ? 6 : 50
}

export function timelineVirtualRowKey(input: {
  rowKey: string | undefined
  index: number
}) {
  return input.rowKey ?? `removed:${input.index}`
}

export function sessionSwitchResetPlan(input: {
  locationHash: string
  pendingMessage: string | undefined
}) {
  return {
    clearMessageId: true,
    restoreScroll: !input.locationHash && !input.pendingMessage,
  }
}

export function timelineMountSessionKey(input: {
  messagesReady: boolean
  sessionKey: string | undefined
}) {
  return input.messagesReady ? input.sessionKey : undefined
}

export function timelineShouldForceNativeBottom(input: {
  hasScrollGesture: boolean
  shouldAnchorBottom: boolean
  rowCount: number
}) {
  return !input.hasScrollGesture && input.shouldAnchorBottom && input.rowCount > 0
}

export function timelineInitialRevealVisibility(input: {
  ready: boolean
}) {
  return input.ready ? "visible" : "hidden"
}

export function timelineInitialRevealShouldScroll(input: {
  hasScrollGesture: boolean
  shouldAnchorBottom: boolean
}) {
  return input.shouldAnchorBottom && !input.hasScrollGesture
}
