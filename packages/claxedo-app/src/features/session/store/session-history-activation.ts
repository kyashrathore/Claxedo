// Pure decisions about one session transport read: when to start it, whether to
// skip or defer it, whether a returned result is still the current one, and what
// its rejection means. `session-goal-query.ts` and `session-capabilities-query.ts`
// share the staleness guard, so these outlive the activation path they are named
// for; nothing here touches reactive state, so each decision is testable alone.
import {
  FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS,
  fastSessionSwitchNetworkQuiet,
  fastSessionSwitchQuietDelay,
} from "@/platform/runtime/session-switch"
import { AgentRuntimeRequestError } from "@/platform/runtime/agent/agent-runtime-request-error"
import { backfillFailedCursor } from "./history-pagination"

export function createActivationSessionReadEpoch() {
  const controller = new AbortController()
  return {
    signal: controller.signal,
    active: () => !controller.signal.aborted,
    abort: () => controller.abort(),
  }
}

export function firstFoldSessionHydrateDelay(input: {
  sessionID: string
  prefetched?: boolean
  now?: number
  baseDelay?: number
}) {
  if (input.prefetched === false) return input.baseDelay ?? 0
  return fastSessionSwitchQuietDelay({
    sessionId: input.sessionID,
    now: input.now,
    baseDelay: input.baseDelay ?? FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS,
  })
}

export function shouldSkipSessionTransportHydrate(input: {
  sessionID: string
  force?: boolean
  before?: string
  bypassQuiet?: boolean
  now?: number
}) {
  if (input.force || input.before || input.bypassQuiet) return false
  return fastSessionSwitchNetworkQuiet({ sessionId: input.sessionID, now: input.now })
}

export function shouldDeferSessionTransportHydrate(input: {
  loading?: boolean
  force?: boolean
}) {
  return input.loading === true && input.force !== true
}

export function shouldAcceptSessionTransportResult(input: {
  expectedSessionID: string
  currentSessionID: string | undefined
  expectedDirectory?: string
  currentDirectory?: string
  expectedActivationEpoch?: number
  currentActivationEpoch?: number
}) {
  if (input.currentSessionID !== input.expectedSessionID) return false
  if (
    input.expectedDirectory !== undefined &&
    input.currentDirectory !== undefined &&
    input.currentDirectory !== input.expectedDirectory
  ) return false
  if (
    input.expectedActivationEpoch !== undefined &&
    input.currentActivationEpoch !== input.expectedActivationEpoch
  ) return false
  return true
}

export function isSessionNotFoundError(error: unknown) {
  const value = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : JSON.stringify(error)
  return value.includes("session_not_found") || value.includes("Session not found") || value.includes("Request failed: 404")
}

/**
 * Whether the session authority refused this principal the read.
 *
 * The private-session authority answers a session it will not disclose with
 * `403 workspace_authorization_denied`, and a share revoked while a pane is
 * open produces exactly that on the pane's next read. The status is the whole
 * contract: workspace authority, session authority and the relay all deny with
 * 403, and every one of them means the same thing to a reader — this principal
 * may not have the transcript.
 */
export function isSessionAccessDeniedError(error: unknown) {
  return error instanceof AgentRuntimeRequestError && error.status === 403
}

export type SessionHistoryReadFailure =
  | { kind: "denied" }
  | { kind: "missing" }
  | { kind: "page"; failedCursor: string }
  | { kind: "unhandled" }

/**
 * How a rejected session-history read is answered.
 *
 * Denial is decided first. An older page the authority refuses is not a cursor
 * to retry later, and a denial reported as `unhandled` escapes the activation
 * path — which fires and forgets its first-fold read — as an unhandled
 * rejection instead of reaching the pane's "session unavailable" surface.
 * `unhandled` is reserved for what it names: a fault with no handled state,
 * which the caller rethrows.
 */
export function classifySessionHistoryReadFailure(input: {
  error: unknown
  before?: string
}): SessionHistoryReadFailure {
  if (isSessionAccessDeniedError(input.error)) return { kind: "denied" }
  const sessionNotFound = isSessionNotFoundError(input.error)
  if (sessionNotFound) return { kind: "missing" }
  const failedCursor = backfillFailedCursor({ before: input.before, sessionNotFound })
  return failedCursor === undefined ? { kind: "unhandled" } : { kind: "page", failedCursor }
}
