import type { Context } from "hono"
import type { SseReplayBuffer } from "@claxedo/agent-sdk-runtime/sse"
import { SESSION_STREAM_LEASE_TTL_MS } from "@claxedo/workspace-relay-protocol"
import { eventSessionId, type CompatEnvelope } from "../compat-events"
import type { WorkspaceRuntimeEvent } from "../bus"
import {
  sessionAccessContext,
  sessionAccessDenied,
  type SessionAccessPolicy,
  type SessionAccessPolicyInput,
} from "../session-access-policy"

export type SessionEventScope =
  | { managed: false; grant?: "workspace" }
  | {
      managed: true
      sessionId: string
      lease: string
      expiresAt: number
      renewalInput: SessionAccessPolicyInput & { sessionId: string }
    }

export function isSessionEventScopeResponse(
  value: SessionEventScope | Response,
): value is Response {
  // `instanceof Response` is not stable across fetch implementations/realms.
  // The scope is our own discriminated value, so identify it by its canonical
  // discriminator and treat every other return as the HTTP denial response.
  return !("managed" in value)
}

type LeaseWatchOptions = {
  now?: () => number
  jitter?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

/**
 * Who is asking decides the scope of a managed runtime's event stream.
 *
 * A principal the authority admits to the workspace opens it unscoped; the
 * stream then carries every session-less frame (pty, process) and, session by
 * session, what the session authority grants that principal. A share grantee
 * holds no workspace access, only a grant on one session, so the stream is a
 * session resource for them: the session id is supplied by the caller and
 * admitted through the same verified relay identity and authority oracle as
 * the REST session routes, under a renewable lease. Unmanaged/local runtimes
 * serve the broad stream to whoever reached them.
 */
/** The refusal code of the unscoped `wr/events` arm; the reader reopens `?sessionID=` on it and on nothing else. */
export const WORKSPACE_EVENT_STREAM_DENIED = "workspace_event_stream_denied"

export async function authorizeSessionEventScope(
  c: Context,
  policy: SessionAccessPolicy | undefined,
): Promise<SessionEventScope | Response> {
  if (policy?.sessionAuthority !== "managed-private") return { managed: false }

  const sessionId = c.req.query("sessionID")?.trim()
  if (!sessionId) {
    if (!policy.authorizeHost) {
      return Response.json({
        error: {
          code: "session_event_scope_required",
          message: "Managed private event streams require sessionID",
        },
      }, { status: 400 })
    }
    const workspace = await policy.authorizeHost({
      ...sessionAccessContext(c),
      operation: "session_event_stream",
      minimumRole: "viewer",
      method: c.req.method,
      path: c.req.path,
    })
    if (workspace.allowed) return { managed: false, grant: "workspace" }
    // A refusal at workspace level is the reader's cue to reopen for one
    // session under a lease; it is named as such so a 403 minted elsewhere on
    // the path (the relay, the token mint) is not mistaken for it.
    if (workspace.status === 403) {
      return Response.json({
        error: { code: WORKSPACE_EVENT_STREAM_DENIED, message: workspace.message, cause: workspace.code },
      }, { status: 403 })
    }
    return sessionAccessDenied(workspace)
  }

  if (!policy.authorizeStream) {
    return Response.json({
      error: {
        code: "session_stream_authority_required",
        message: "Managed private event streams require renewable session authority",
      },
    }, { status: 503 })
  }

  const access = sessionAccessContext(c)
  const input = {
    ...access,
    operation: "session_event_stream",
    sessionId,
    method: c.req.method,
    path: c.req.path,
    signal: c.req.raw.signal,
  } satisfies SessionAccessPolicyInput & { sessionId: string }
  const decision = await policy.authorizeStream(input)
  if (!decision.allowed) return sessionAccessDenied(decision)
  const now = Date.now()
  if (!decision.lease.trim() || !Number.isFinite(decision.expiresAt) || decision.expiresAt <= now) {
    return Response.json({
      error: {
        code: "session_stream_authority_invalid_response",
        message: "Session authority returned an invalid stream lease",
      },
    }, { status: 503 })
  }

  // The connection-establishment RHT is intentionally not retained by the
  // long-lived stream. Renewals use the short lease and the authority service
  // rechecks its durable parent RAT plus current session membership.
  const { credential: _credential, signal: _requestSignal, ...renewalInput } = input
  return {
    managed: true,
    sessionId,
    lease: decision.lease,
    // Never let control-plane/runtime clock skew extend a lease beyond the
    // frozen local security bound. An earlier signed expiry still wins.
    expiresAt: Math.min(decision.expiresAt, now + SESSION_STREAM_LEASE_TTL_MS),
    renewalInput,
  }
}

/**
 * Keeps a managed event stream alive only while its renewable authority lease
 * remains current. Any denial, malformed renewal, or authority outage closes
 * the stream; a reconnect must present a fresh RHT and cannot continue on stale
 * establishment-time identity.
 */
export function watchSessionEventLease(
  scope: SessionEventScope,
  policy: SessionAccessPolicy | undefined,
  onRevoked: () => void | Promise<void>,
  options: LeaseWatchOptions = {},
) {
  if (!scope.managed) return () => {}

  // Bound, not detached: `authorizeStream` is a policy method that may close
  // over its own policy object.
  const authorizeStream = policy?.authorizeStream?.bind(policy)
  if (!authorizeStream) {
    void Promise.resolve().then(onRevoked).catch(() => {})
    return () => {}
  }

  const now = options.now ?? Date.now
  const jitter = options.jitter ?? Math.random
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer = options.clearTimer ?? clearTimeout
  let lease = scope.lease
  let expiresAt = scope.expiresAt
  let renewalTimer: ReturnType<typeof setTimeout> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let renewalAbort: AbortController | undefined
  let stopped = false

  const stop = () => {
    if (stopped) return
    stopped = true
    if (renewalTimer !== undefined) clearTimer(renewalTimer)
    if (expiryTimer !== undefined) clearTimer(expiryTimer)
    renewalAbort?.abort()
    renewalTimer = undefined
    expiryTimer = undefined
    renewalAbort = undefined
  }

  const revoke = () => {
    if (stopped) return
    stop()
    void Promise.resolve().then(onRevoked).catch(() => {})
  }

  const schedule = () => {
    const remainingMs = expiresAt - now()
    if (remainingMs <= 0) {
      revoke()
      return
    }
    // A hard expiry timer closes the stream even if the authority request
    // stalls. Renewal begins up to five seconds early (the oracle's bounded
    // request deadline), so a network timeout can never extend stale access.
    expiryTimer = setTimer(revoke, remainingMs)
    const renewalLeadMs = Math.min(5_000, Math.max(1, remainingMs / 3))
    // Renew only earlier than the fixed safety deadline, with bounded jitter.
    // Cohorts that establish together therefore do not stampede the authority
    // or synchronize their fail-closed reconnects.
    const jitterWindowMs = Math.min(2_000, remainingMs / 6)
    const jitterMs = Math.max(0, Math.min(1, jitter())) * jitterWindowMs
    renewalTimer = setTimer(() => void renew(), Math.max(1, remainingMs - renewalLeadMs - jitterMs))
  }

  const renew = async () => {
    if (stopped) return
    const controller = new AbortController()
    renewalAbort = controller
    const decision = await Promise.resolve()
      .then(() => authorizeStream({ ...scope.renewalInput, signal: controller.signal }, lease))
      .catch(() => undefined)
    if (renewalAbort === controller) renewalAbort = undefined
    const renewedAt = now()
    if (
      stopped
      || !decision
      || !decision.allowed
      || !decision.lease.trim()
      || !Number.isFinite(decision.expiresAt)
      || decision.expiresAt <= renewedAt
    ) {
      if (!stopped) revoke()
      return
    }
    if (renewalTimer !== undefined) clearTimer(renewalTimer)
    if (expiryTimer !== undefined) clearTimer(expiryTimer)
    renewalTimer = undefined
    expiryTimer = undefined
    lease = decision.lease
    expiresAt = Math.min(decision.expiresAt, renewedAt + SESSION_STREAM_LEASE_TTL_MS)
    schedule()
  }

  schedule()
  return stop
}

export async function waitForSessionEventStream(
  stream: { onAbort(callback: () => void): void; close(): Promise<void> },
  scope: SessionEventScope,
  policy: SessionAccessPolicy | undefined,
  cleanup: () => void,
) {
  await new Promise<void>((resolve) => {
    let finished = false
    let stopLeaseWatch = () => {}
    const finish = () => {
      if (finished) return
      finished = true
      stopLeaseWatch()
      cleanup()
      resolve()
    }
    stopLeaseWatch = watchSessionEventLease(scope, policy, async () => {
      finish()
      await stream.close().catch(() => {})
    })
    stream.onAbort(finish)
  })
}

export function compatEnvelopeSessionId(event: CompatEnvelope) {
  return eventSessionId(event.payload)
}

/**
 * The session a control frame belongs to. A pty bound to a session (its
 * bytes, its exit) is that session's: a reader without a grant on the session
 * must not see the terminal the agent drove. A pty bound to none is the
 * workspace's.
 */
export function workspaceRuntimeEventSessionId(event: WorkspaceRuntimeEvent): string | undefined {
  switch (event.type) {
    case "agent.lifecycle":
      return event.sessionId
    case "session.lifecycle":
      return event.sessionID
    case "pty.created":
    case "pty.updated":
      return event.info.sessionId
    case "pty.exited":
    case "pty.deleted":
    case "pty.stream":
      return event.sessionId
    default:
      return undefined
  }
}

export function scopedReplay<T>(
  replay: SseReplayBuffer<T>,
  allows: (event: T) => boolean,
): SseReplayBuffer<T> {
  return {
    push: (event) => replay.push(event),
    idFor: (event) => replay.idFor(event),
    lastId: () => replay.lastId(),
    hasGap: (lastEventId, throughId) => replay.hasGap(lastEventId, throughId),
    replayAfter: (lastEventId, throughId) => replay.replayAfter(lastEventId, throughId)
      .filter((event) => allows(event.payload)),
    isTerminal: (event) => replay.isTerminal(event),
  }
}
