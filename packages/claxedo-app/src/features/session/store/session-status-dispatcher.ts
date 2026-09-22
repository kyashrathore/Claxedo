import type { AgentRuntimeStatus as SessionStatus, RecoveryAction, RecoveryOutcome } from "@claxedo/agent-runtime-contract"
import { shellDataKeys } from "@/platform/sync/keys"
import {
  setSessionRequestsQueryData as writeSessionRequestsQueryData,
  setSessionStatusQueryData as writeSessionStatusQueryData,
  setSessionTodoQueryData as writeSessionTodoQueryData,
} from "../data/sync/writers"
import type { SessionRequestsQueryData, Todo } from "../data/sync/queries"
import { queryClient, removeExactQuery } from "@/platform/query/query-client"
import { observeSessionStatusEvent } from "./session-status-telemetry"
import { hasPendingPrompt } from "./pending-prompt-registry"
import { isRecord, readField, readString } from "@/lib/record"

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

/**
 * The latest Stop this client sent for a session, so a second Stop for the
 * same turn joins it instead of opening a conflicting request.
 *
 * This is deliberately not a session status: a Stop that is in flight, or one
 * that came back saying the harness may still be running, says nothing about
 * what the transcript is doing. Writing either into the status query would
 * replace the last thing the runtime actually reported with a guess.
 */
export type SessionRecoveryCommand = {
  requestId: string
  action: RecoveryAction
  attempt: number
  startedAt: number
  /** The turn this command names, when it names one. */
  turnId?: string
  /** The attempt this one follows, for a retry. */
  linkedOperationId?: string
  /** Absent while the owner has not answered. */
  outcome?: RecoveryOutcome
  /** Set when the request never reached an owner, so there is no outcome to read. */
  unreachable?: string
}

const RECOVERY_COMMAND_KEY_PART = "recovery-command"

type SessionStatusTimeout = ReturnType<typeof setTimeout>

const promptSessionStatusTimeouts = new Map<string, SessionStatusTimeout[]>()

function createSessionNotificationDispatcher() {
  const byActivity = new Map<string, Set<VoidFunction>>()
  const byStatusMeta = new Map<string, Set<VoidFunction>>()
  const byRecoveryCommand = new Map<string, Set<VoidFunction>>()
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
        : type === RECOVERY_COMMAND_KEY_PART
          ? byRecoveryCommand.get(sessionID)
          : type === "status" || type === "requests"
            ? byActivity.get(sessionID)
            : undefined
      for (const listener of listeners ?? []) listener()
    },
    subscribeActivity: (sessionID: string, listener: VoidFunction) => subscribe(byActivity, sessionID, listener),
    subscribeStatusMeta: (sessionID: string, listener: VoidFunction) => subscribe(byStatusMeta, sessionID, listener),
    subscribeRecoveryCommand: (sessionID: string, listener: VoidFunction) =>
      subscribe(byRecoveryCommand, sessionID, listener),
    recoveryCommandListeners: (sessionID: string) => byRecoveryCommand.get(sessionID)?.size ?? 0,
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

// One contract for session-status writes:
//
// * A server-source event that lands ALWAYS clears optimistic timeout metadata
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
  // `prompt_async` answers only once the runtime has settled the turn's
  // admission, so while a prompt for this session is still pending the runtime
  // cannot have run that turn yet: an idle it reports — or an omission from
  // `/session/status`, which reaches here as one — describes the state before
  // the prompt and can never be that turn ending. Taking it would drop the
  // Thinking row and reinstate it a round trip later, under the pointer. An
  // error is an answer to the prompt, so it still lands.
  if (
    input.event.source === "server"
    && input.event.type !== "session.error"
    && status.type === "idle"
    && hasPendingPrompt(input.event.sessionID)
  ) return
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

type RetryAction = NonNullable<Extract<SessionStatus, { type: "retry" }>["action"]>

function retryAction(value: unknown): RetryAction | undefined {
  if (!isRecord(value)) return undefined
  const { reason, provider, title, message, label, link } = value
  if (
    typeof reason !== "string" || typeof provider !== "string" || typeof title !== "string"
    || typeof message !== "string" || typeof label !== "string"
  ) return undefined
  return { reason, provider, title, message, label, ...(typeof link === "string" ? { link } : {}) }
}

/**
 * The status payload of a `session.status` frame, or of the status client's
 * untyped record.
 *
 * Both reach the app as opaque JSON, so the discriminated `AgentRuntimeStatus`
 * union has to be re-established once — here. A payload matching no arm is
 * dropped rather than forwarded into the status query, where a malformed `type`
 * would render as an unknown stage forever.
 */
export function sessionStatus(value: unknown): SessionStatus | undefined {
  if (!isRecord(value)) return undefined
  switch (value.type) {
    case "idle":
    case "busy":
      return { type: value.type }
    case "retry": {
      const { attempt, message, next } = value
      if (typeof attempt !== "number" || typeof message !== "string" || typeof next !== "number") return undefined
      const action = retryAction(value.action)
      return { type: "retry", attempt, message, next, ...(action ? { action } : {}) }
    }
    case "recovering":
      return (value.kind === "process_restart" || value.kind === "uncertain_execution") && typeof value.message === "string"
        ? { type: "recovering", kind: value.kind, message: value.message }
        : undefined
    default:
      return undefined
  }
}

export function applySessionStatusSseEvent(input: {
  event: { type: string; properties?: unknown }
  directory?: string
}) {
  switch (input.event.type) {
    case "session.status": {
      const sessionID = readString(input.event.properties, "sessionID")
      if (!sessionID) return false
      const status = sessionStatus(readField(input.event.properties, "status"))
      observeSessionStatusEvent({ directory: input.directory, sessionID, status })
      dispatchSessionStatusEvent({
        event: { type: "session.status", source: "server", sessionID, status },
      })
      return true
    }
    case "session.idle": {
      const sessionID = readString(input.event.properties, "sessionID")
      if (!sessionID) return false
      observeSessionStatusEvent({ directory: input.directory, sessionID, status: { type: "idle" } })
      dispatchSessionStatusEvent({
        event: { type: "session.idle", source: "server", sessionID },
      })
      return true
    }
    case "session.error": {
      const sessionID = readString(input.event.properties, "sessionID")
      if (!sessionID) return false
      observeSessionStatusEvent({ directory: input.directory, sessionID, status: { type: "idle" } })
      dispatchSessionStatusEvent({
        event: { type: "session.error", source: "server", sessionID },
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

export function sessionRecoveryCommand(sessionID: string | undefined) {
  if (!sessionID) return undefined
  return queryClient.getQueryData<SessionRecoveryCommand>(recoveryCommandKey(sessionID))
}

export function subscribeSessionRecoveryCommand(sessionID: string, listener: VoidFunction) {
  return sessionNotifications.subscribeRecoveryCommand(sessionID, listener)
}

/**
 * A command still waiting for its answer is never replaced by an earlier
 * attempt: a plain Stop landing while a retry is in flight would otherwise put
 * attempt 1 back over attempt 2, and the retry's answer would then be dropped
 * as belonging to a superseded request.
 */
export function startSessionRecoveryCommand(input: {
  sessionID: string
  requestId: string
  action: RecoveryAction
  attempt: number
  turnId?: string
  linkedOperationId?: string
  now?: number
}) {
  const current = sessionRecoveryCommand(input.sessionID)
  const inFlight = current !== undefined && current.outcome === undefined && current.unreachable === undefined
  if (inFlight && current.requestId !== input.requestId && current.attempt > input.attempt) return false
  writeRecoveryCommand(input.sessionID, {
    requestId: input.requestId,
    action: input.action,
    attempt: input.attempt,
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    ...(input.linkedOperationId !== undefined ? { linkedOperationId: input.linkedOperationId } : {}),
    startedAt: input.now ?? Date.now(),
  })
  return true
}

/**
 * The request id a Stop should submit under: the one already in flight when
 * this is the same command against the same turn, or a new one.
 *
 * Joining is only correct for an identical intent. An owner compares the whole
 * intent behind a repeated request id, so a plain Stop reusing a retry's id — a
 * different attempt, linked to a different operation — is refused as an intent
 * conflict. The command row is the record of what is in flight, so there is no
 * second index of it to fall out of step.
 */
export function cancellationRequestId(input: {
  sessionID: string
  turnId: string
  attempt: number
  linkedOperationId?: string
  mint: () => string
}) {
  const current = sessionRecoveryCommand(input.sessionID)
  const inFlight = current !== undefined && current.outcome === undefined && current.unreachable === undefined
  const sameIntent = inFlight
    && current.action === "cancel_turn"
    && current.turnId === input.turnId
    && current.attempt === input.attempt
    && current.linkedOperationId === input.linkedOperationId
  return sameIntent ? current.requestId : input.mint()
}

/**
 * A late answer to a superseded request is dropped, so the command always
 * describes the newest attempt.
 */
export function settleSessionRecoveryCommand(input: {
  sessionID: string
  requestId: string
  outcome: RecoveryOutcome
}) {
  const current = sessionRecoveryCommand(input.sessionID)
  if (current?.requestId !== input.requestId) return false
  writeRecoveryCommand(input.sessionID, { ...current, outcome: input.outcome })
  return true
}

export function failSessionRecoveryCommand(input: { sessionID: string; requestId: string; message: string }) {
  const current = sessionRecoveryCommand(input.sessionID)
  if (current?.requestId !== input.requestId) return false
  writeRecoveryCommand(input.sessionID, { ...current, unreachable: input.message })
  return true
}

export function clearSessionRecoveryCommand(sessionID: string) {
  writeRecoveryCommand(sessionID)
}

function writeRecoveryCommand(sessionID: string, command?: SessionRecoveryCommand) {
  if (!command) {
    removeExactQuery(recoveryCommandKey(sessionID))
    return
  }
  queryClient.setQueryData(recoveryCommandKey(sessionID), command)
}

function recoveryCommandKey(sessionID: string) {
  return shellDataKeys.sessionId(sessionID, RECOVERY_COMMAND_KEY_PART)
}

/** How many live readers this session's recovery command has, for leak checks. */
export function sessionRecoveryCommandListenersForTest(sessionID: string) {
  return sessionNotifications.recoveryCommandListeners(sessionID)
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
  return undefined
}

function stageRank(stage: SessionStatusStage | undefined) {
  if (stage === "redispatch") return 1
  if (stage === "pending") return 2
  if (stage === "long") return 3
  if (stage === "failed") return 4
  return 0
}
