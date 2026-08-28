import type { Context } from "hono"
import type { SseReplayBuffer } from "@claxedo/agent-sdk-runtime/sse"
import { eventSessionId, type CompatEnvelope } from "../compat-events"
import type { WorkspaceRuntimeEvent } from "../bus"
import {
  sessionAccessContext,
  sessionAccessDenied,
  type SessionAccessPolicy,
  type SessionAccessPolicyInput,
} from "../session-access-policy"

export type SessionEventScope =
  | { managed: false }
  | {
      managed: true
      sessionId: string
      lease: string
      expiresAt: number
      renewalInput: SessionAccessPolicyInput & { sessionId: string }
    }

type LeaseWatchOptions = {
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

/**
 * Managed-private event streams are session resources, not workspace-wide
 * broadcast channels. The session id is supplied by the caller and admitted
 * through the same verified relay identity and authority oracle as the REST
 * session routes. Unmanaged/local runtimes retain their existing broad stream.
 */
export async function authorizeSessionEventScope(
  c: Context,
  policy: SessionAccessPolicy | undefined,
  queryName: "sessionID" | "parentSessionId",
): Promise<SessionEventScope | Response> {
  if (policy?.sessionAuthority !== "managed-private") return { managed: false }

  const sessionId = c.req.query(queryName)?.trim()
  if (!sessionId) {
    return Response.json({
      error: {
        code: "session_event_scope_required",
        message: `Managed private event streams require ${queryName}`,
      },
    }, { status: 400 })
  }

  if (!policy.authorizeStream) {
    return Response.json({
      error: {
        code: "session_stream_authority_required",
        message: "Managed private event streams require renewable session authority",
      },
    }, { status: 503 })
  }

  const access = sessionAccessContext(c as never)
  const input = {
    ...access,
    operation: "session_event_stream",
    sessionId,
    method: c.req.method,
    path: c.req.path,
  } satisfies SessionAccessPolicyInput & { sessionId: string }
  const decision = await policy.authorizeStream(input)
  if (!decision.allowed) return sessionAccessDenied(decision)
  if (!decision.lease.trim() || !Number.isFinite(decision.expiresAt) || decision.expiresAt <= Date.now()) {
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
  const { credential: _credential, ...renewalInput } = input
  return {
    managed: true,
    sessionId,
    lease: decision.lease,
    expiresAt: decision.expiresAt,
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

  const authorizeStream = policy?.authorizeStream
  if (!authorizeStream) {
    void onRevoked()
    return () => {}
  }

  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer = options.clearTimer ?? clearTimeout
  let lease = scope.lease
  let expiresAt = scope.expiresAt
  let renewalTimer: ReturnType<typeof setTimeout> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const stop = () => {
    if (stopped) return
    stopped = true
    if (renewalTimer !== undefined) clearTimer(renewalTimer)
    if (expiryTimer !== undefined) clearTimer(expiryTimer)
    renewalTimer = undefined
    expiryTimer = undefined
  }

  const revoke = () => {
    if (stopped) return
    stop()
    void Promise.resolve(onRevoked()).catch(() => {})
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
    renewalTimer = setTimer(() => void renew(), Math.max(1, remainingMs - renewalLeadMs))
  }

  const renew = async () => {
    if (stopped) return
    const decision = await Promise.resolve(authorizeStream(scope.renewalInput, lease)).catch(() => undefined)
    if (
      stopped
      || !decision
      || !decision.allowed
      || !decision.lease.trim()
      || !Number.isFinite(decision.expiresAt)
      || decision.expiresAt <= now()
    ) {
      if (!stopped) revoke()
      return
    }
    if (renewalTimer !== undefined) clearTimer(renewalTimer)
    if (expiryTimer !== undefined) clearTimer(expiryTimer)
    renewalTimer = undefined
    expiryTimer = undefined
    lease = decision.lease
    expiresAt = decision.expiresAt
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

export function workspaceRuntimeEventSessionId(event: WorkspaceRuntimeEvent): string | undefined {
  switch (event.type) {
    case "agent.lifecycle":
      return event.sessionId
    case "session.lifecycle":
      return event.sessionID
    case "session.updated": {
      const properties = record(event.properties)
      const info = record(properties?.info)
      return text(properties?.sessionID) ?? text(properties?.sessionId) ?? text(info?.sessionID) ?? text(info?.id)
    }
    default:
      return undefined
  }
}

/** Extracts only producer-owned session identifiers; it never guesses from directory/tab ids. */
export function unknownEventSessionId(event: unknown): string | undefined {
  const row = record(event)
  if (!row) return undefined
  const properties = record(row.properties)
  const info = record(properties?.info)
  const part = record(properties?.part)
  const payload = record(row.payload)
  return text(row.sessionID)
    ?? text(row.sessionId)
    ?? text(properties?.sessionID)
    ?? text(properties?.sessionId)
    ?? text(info?.sessionID)
    ?? text(info?.id)
    ?? text(part?.sessionID)
    ?? (payload ? unknownEventSessionId(payload) : undefined)
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

function record(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined
}

function text(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}
