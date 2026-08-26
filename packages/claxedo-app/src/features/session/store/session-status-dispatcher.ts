import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { shellDataKeys } from "@/platform/sync/keys"
import {
  setSessionRequestsQueryData as writeSessionRequestsQueryData,
  setSessionStatusQueryData as writeSessionStatusQueryData,
  setSessionTodoQueryData as writeSessionTodoQueryData,
} from "../data/sync/writers"
import type { SessionRequestsQueryData, Todo } from "../data/sync/queries"
import { queryClient, removeExactQuery } from "@/platform/query/query-client"
import { observeSessionStatusEvent } from "./session-status-telemetry"

const OPTIMISTIC_STATUS_REDISPATCH_MS = 8_000
const OPTIMISTIC_STATUS_PENDING_MS = 20_000
const OPTIMISTIC_STATUS_LONG_MS = 45_000
const OPTIMISTIC_STATUS_FAILURE_MS = 5 * 60_000

export const SESSION_STATUS_TIMEOUTS = {
  redispatch: OPTIMISTIC_STATUS_REDISPATCH_MS,
  pending: OPTIMISTIC_STATUS_PENDING_MS,
  long: OPTIMISTIC_STATUS_LONG_MS,
  failure: OPTIMISTIC_STATUS_FAILURE_MS,
}

type SessionStatusStage = "redispatch" | "pending" | "long" | "failed"

type PromptSessionStatusMeta = {
  source: "optimistic"
  started: number
  deadline: number
  stage?: SessionStatusStage
}

export type SessionStatusDispatchEvent =
  | {
      type: "session.status"
      source: "optimistic" | "server"
      sessionID: string
      status?: SessionStatus
      deadline?: number
      now?: number
    }
  | {
      type: "session.idle" | "session.error"
      source: "optimistic" | "server"
      sessionID: string
      deadline?: number
      now?: number
    }

export type SessionRequestsDispatchEvent = {
  type: "session.requests"
  source: "optimistic" | "server"
  sessionID: string
  requests: SessionRequestsQueryData | ((previous: SessionRequestsQueryData | undefined) => SessionRequestsQueryData)
}

export type SessionTodoDispatchEvent = {
  type: "session.todo"
  source: "optimistic" | "server"
  sessionID: string
  todos: Todo[]
}

export type SessionStatusTimeoutStageEvent = {
  type: "session.status.timeout"
  sessionID: string
  stage: SessionStatusStage
}

type SessionStatusTimeout = ReturnType<typeof setTimeout>

const promptSessionStatusTimeouts = new Map<string, SessionStatusTimeout[]>()

function createSessionNotificationDispatcher() {
  const byActivity = new Map<string, Set<VoidFunction>>()
  const byStatusMeta = new Map<string, Set<VoidFunction>>()
  const subscribe = (index: Map<string, Set<VoidFunction>>, sessionID: string, listener: VoidFunction) => {
    const listeners = index.get(sessionID) ?? new Set<VoidFunction>()
    listeners.add(listener)
    index.set(sessionID, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) index.delete(sessionID)
    }
  }
  return {
    notify(sessionID: string, type: unknown) {
      const listeners = type === "status-meta"
        ? byStatusMeta.get(sessionID)
        : type === "status" || type === "requests"
          ? byActivity.get(sessionID)
          : undefined
      for (const listener of listeners ?? []) listener()
    },
    subscribeActivity: (sessionID: string, listener: VoidFunction) => subscribe(byActivity, sessionID, listener),
    subscribeStatusMeta: (sessionID: string, listener: VoidFunction) => subscribe(byStatusMeta, sessionID, listener),
  }
}

const sessionNotifications = createSessionNotificationDispatcher()

// Status and request data is push-owned but stored in QueryClient. Solid Query
// observers with `enabled: false` do not reliably publish every external cache
// write, while one broad QueryCache epoch wakes every mounted session. Keep a
// single cache listener at the authoritative dispatcher boundary and publish
// only to subscribers for the session whose cache entry changed.
queryClient.getQueryCache().subscribe((event) => {
  const key = event.query.queryKey
  if (key[0] !== "shell" || key[1] !== "session") return
  const sessionID = typeof key[2] === "string" ? key[2] : undefined
  if (!sessionID) return
  sessionNotifications.notify(sessionID, key[3])
})

export function subscribeSessionActivity(sessionID: string, listener: VoidFunction) {
  return sessionNotifications.subscribeActivity(sessionID, listener)
}

// One contract for session-status writes (rubric C2):
//
// * A server-source event ALWAYS clears optimistic timeout metadata
//   for that session, regardless of phase.
//
// * An optimistic-source event with a non-idle status EXTENDS the
//   existing optimistic period: `started` and `deadline` are preserved
//   if present, otherwise initialized from `now`.
//
// * Timeout stage writes never create optimistic state. If the server has
//   already cleared metadata, a late timeout is a no-op ("server wins").

export function dispatchSessionStatusEvent(input: {
  event: SessionStatusDispatchEvent
}) {
  const status: SessionStatus =
    input.event.type === "session.status" ? input.event.status ?? { type: "idle" } : { type: "idle" }
  setSessionStatusQueryData(input.event.sessionID, status)
  if (input.event.source === "server" || input.event.type !== "session.status" || !input.event.status || input.event.status.type === "idle") {
    clearPromptSessionStatusTimeouts(input.event.sessionID)
    setPromptSessionStatusMeta(input.event.sessionID)
  } else {
    setPromptSessionStatusMeta(input.event.sessionID, optimisticMetaForEvent(input.event))
  }
}

export function dispatchSessionRequestsEvent(input: {
  event: SessionRequestsDispatchEvent
}) {
  writeSessionRequestsQueryData({
    queryClient,
    sessionId: input.event.sessionID,
    requests: input.event.requests,
  })
}

export function dispatchSessionTodoEvent(input: {
  event: SessionTodoDispatchEvent
}) {
  writeSessionTodoQueryData({
    queryClient,
    sessionId: input.event.sessionID,
    todos: input.event.todos,
  })
}

export function applySessionStatusSseEvent(input: {
  event: { type: string; properties?: unknown }
  directory?: string
}) {
  switch (input.event.type) {
    case "session.status": {
      const props = input.event.properties as { sessionID?: string; status?: SessionStatus }
      if (!props.sessionID) return false
      observeSessionStatusEvent({
        directory: input.directory,
        sessionID: props.sessionID,
        status: props.status,
      })
      dispatchSessionStatusEvent({
        event: { type: "session.status", source: "server", sessionID: props.sessionID, status: props.status },
      })
      return true
    }
    case "session.idle": {
      const props = input.event.properties as { sessionID?: string }
      if (!props.sessionID) return false
      observeSessionStatusEvent({
        directory: input.directory,
        sessionID: props.sessionID,
        status: { type: "idle" },
      })
      dispatchSessionStatusEvent({
        event: { type: "session.idle", source: "server", sessionID: props.sessionID },
      })
      return true
    }
    case "session.error": {
      const props = input.event.properties as { sessionID?: string }
      if (!props.sessionID) return false
      observeSessionStatusEvent({
        directory: input.directory,
        sessionID: props.sessionID,
        status: { type: "idle" },
      })
      dispatchSessionStatusEvent({
        event: { type: "session.error", source: "server", sessionID: props.sessionID },
      })
      return true
    }
  }
  return false
}

export function dispatchSessionStatusTimeoutStage(input: {
  event: SessionStatusTimeoutStageEvent
}) {
  const meta = promptSessionStatusMeta(input.event.sessionID)
  const status = queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId(input.event.sessionID, "status"))
  if (!meta || !status || status.type === "idle") {
    setPromptSessionStatusMeta(input.event.sessionID)
    return false
  }
  if (stageRank(input.event.stage) <= stageRank(meta.stage)) return false
  const timeoutStatus = statusForTimeoutStage(input.event.stage)
  if (timeoutStatus) setSessionStatusQueryData(input.event.sessionID, timeoutStatus)
  setPromptSessionStatusTimeoutStage(input.event.sessionID, input.event.stage)
  return input.event.stage === "redispatch"
}

export function schedulePromptSessionStatusTimeouts(input: {
  sessionID: string
  refreshDirectory?: VoidFunction
}) {
  if (promptSessionStatusTimeouts.has(input.sessionID)) return
  promptSessionStatusTimeouts.set(input.sessionID, [
    scheduleTimeout(input, "redispatch", scaledStatusTimeout(OPTIMISTIC_STATUS_REDISPATCH_MS)),
    scheduleTimeout(input, "pending", scaledStatusTimeout(OPTIMISTIC_STATUS_PENDING_MS)),
    scheduleTimeout(input, "long", scaledStatusTimeout(OPTIMISTIC_STATUS_LONG_MS)),
    scheduleTimeout(input, "failed", scaledStatusTimeout(OPTIMISTIC_STATUS_FAILURE_MS)),
  ])
}

// Test-only escalation-timer scale. The "failed" stage otherwise fires at five
// minutes of real wall-clock (OPTIMISTIC_STATUS_FAILURE_MS), which no CI-speed
// spec can wait for; a spec that needs to reach a late stage sets a small
// positive factor on this window hook BEFORE first navigation so the four
// escalation delays scale down proportionally (order between stages is
// preserved). Double-gated: only consulted in a DEV build OR a prebuilt e2e
// bundle (`VITE_CLAXEDO_E2E==="1"`, baked at build — CI serves a production
// build via `vite preview`, where `import.meta.env.DEV` is false, so gating on
// DEV alone strips this seam and the ladder never scales; stripped from real
// production, same as the `__claxedoConnections` reconnect hatch) AND only when
// the hook holds a finite positive number. This scales only these timers, not the
// mock's separate SSE reconnect backoff.
function scaledStatusTimeout(ms: number): number {
  if ((!import.meta.env.DEV && import.meta.env.VITE_CLAXEDO_E2E !== "1") || typeof window === "undefined") return ms
  const scale = (window as typeof window & { __claxedoStatusTimerScale?: unknown }).__claxedoStatusTimerScale
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0) return ms
  return Math.max(1, Math.round(ms * scale))
}

export function clearPromptSessionStatusTimeouts(sessionID: string) {
  const timeouts = promptSessionStatusTimeouts.get(sessionID)
  if (!timeouts) return
  for (const timeout of timeouts) clearTimeout(timeout)
  promptSessionStatusTimeouts.delete(sessionID)
}

export function clearPromptSessionStatus(sessionID: string) {
  clearPromptSessionStatusTimeouts(sessionID)
  setPromptSessionStatusMeta(sessionID)
}

export function promptSessionStatusMeta(sessionID: string | undefined) {
  if (!sessionID) return undefined
  return queryClient.getQueryData<PromptSessionStatusMeta>(promptSessionStatusMetaKey(sessionID))
}

export function promptSessionStatusStage(sessionID: string | undefined) {
  return promptSessionStatusMeta(sessionID)?.stage
}

/**
 * Notifies `listener` whenever this session's status-meta cache entry changes
 * (stage escalation writes AND the remove-on-reconcile clear). status-meta is
 * written with plain `setQueryData`/exact removal — there is no query
 * observer on it — so UI reads of `promptSessionStatusStage` are NOT reactive
 * on their own; consumers that render the stage must resubscribe through this
 * to re-read after each escalation timer fires.
 */
export function subscribePromptSessionStatusMeta(sessionID: string, listener: VoidFunction) {
  return sessionNotifications.subscribeStatusMeta(sessionID, listener)
}

export function clearAllPromptSessionStatusTimeoutsForTest() {
  for (const sessionID of promptSessionStatusTimeouts.keys()) {
    clearPromptSessionStatusTimeouts(sessionID)
  }
}

export function setSessionStatusQueryData(sessionID: string, status: SessionStatus) {
  const current = queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId(sessionID, "status"))
  if (sameSessionStatus(current, status)) return
  writeSessionStatusQueryData({ queryClient, sessionId: sessionID, status })
}

function sameSessionStatus(left: SessionStatus | undefined, right: SessionStatus) {
  if (!left) return false
  return JSON.stringify(left) === JSON.stringify(right)
}

function setPromptSessionStatusMeta(sessionID: string, meta?: PromptSessionStatusMeta) {
  if (meta) {
    queryClient.setQueryData(promptSessionStatusMetaKey(sessionID), meta)
    return
  }
  removeExactQuery(promptSessionStatusMetaKey(sessionID))
}

function optimisticMetaForEvent(event: Extract<SessionStatusDispatchEvent, { type: "session.status" }>) {
  const now = event.now ?? Date.now()
  const current = promptSessionStatusMeta(event.sessionID)
  return {
    source: "optimistic" as const,
    started: current?.started ?? now,
    deadline: event.deadline ?? current?.deadline ?? now + OPTIMISTIC_STATUS_FAILURE_MS,
    stage: current?.stage,
  }
}

function setPromptSessionStatusTimeoutStage(sessionID: string, stage: SessionStatusStage) {
  const current = promptSessionStatusMeta(sessionID)
  if (!current || stageRank(stage) <= stageRank(current.stage)) return
  setPromptSessionStatusMeta(sessionID, { ...current, stage })
}

function promptSessionStatusMetaKey(sessionID: string) {
  return shellDataKeys.sessionId(sessionID, "status-meta")
}

function scheduleTimeout(
  input: {
    sessionID: string
    refreshDirectory?: VoidFunction
  },
  stage: SessionStatusStage,
  delay: number,
) {
  const timeout = setTimeout(() => {
    const refresh = dispatchSessionStatusTimeoutStage({
      event: { type: "session.status.timeout", sessionID: input.sessionID, stage },
    })
    if (refresh) input.refreshDirectory?.()
    if (stage === "failed") clearPromptSessionStatusTimeouts(input.sessionID)
  }, delay)
  const unrefTimeout = timeout as SessionStatusTimeout & { unref?: () => void }
  unrefTimeout.unref?.()
  return timeout
}

function statusForTimeoutStage(stage: SessionStatusStage): SessionStatus | undefined {
  if (stage === "pending") {
    return {
      type: "retry",
      attempt: 1,
      message: "Still waiting for the server to acknowledge this run.",
      next: 0,
    }
  }
  if (stage === "long") {
    return {
      type: "retry",
      attempt: 1,
      message: "Still waiting for a server update. You can cancel this run if it does not recover.",
      next: 0,
    }
  }
  if (stage === "failed") {
    return {
      type: "retry",
      attempt: 1,
      message: "No server update was received after five minutes. Check this run before sending another prompt.",
      next: 0,
    }
  }
}

function stageRank(stage: SessionStatusStage | undefined) {
  if (stage === "redispatch") return 1
  if (stage === "pending") return 2
  if (stage === "long") return 3
  if (stage === "failed") return 4
  return 0
}
