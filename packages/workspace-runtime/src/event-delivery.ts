import { createSseReplayBuffer, type SseReplayBuffer } from "@claxedo/agent-sdk-runtime/sse"
import { randomUUID } from "node:crypto"
import type { Context } from "hono"
import { SESSION_STREAM_LEASE_TTL_MS } from "@claxedo/workspace-relay-protocol"
import type { SessionAccessPolicy } from "./session-access-policy"

export type WorkspaceRole = "viewer" | "editor" | "admin" | "owner"

export type EventDeliveryPrincipal =
  | { mode: "unmanaged-local"; connectionId: string }
  | {
      mode: "verified"
      connectionId: string
      actorId: string
      actorKind: "human" | "agent"
      orgId: string
      workspaceId: string
      role: WorkspaceRole
      credential?: string
      /** The one session a session-scoped connection reads; its scope's ring numbers only that session's frames. */
      sessionScope?: string
    }

export type EventDeliveryDecision = "deliver" | "omit" | "terminate"

export type EventDeliveryPolicy<T> = ((input: {
  principal: EventDeliveryPrincipal
  event: T
  sessionId?: string
  /** The one actor a session-less frame is for (a create's own protocol, before the session exists). */
  actorId?: string
  sensitive: boolean
}) => EventDeliveryDecision | Promise<EventDeliveryDecision>) & {
  renew?: (principal: EventDeliveryPrincipal) => EventDeliveryDecision | Promise<EventDeliveryDecision>
  release?: (principal: EventDeliveryPrincipal) => void
  /** The workspace stream lease a connection was admitted with; presented for every session it first sees. */
  holdHost?: (principal: EventDeliveryPrincipal, lease: { lease: string; expiresAt: number }) => void
  /** The session lease a session-scoped connection was admitted with: that session is granted, and renewed on it. */
  holdSession?: (principal: EventDeliveryPrincipal, sessionId: string, lease: { lease: string; expiresAt: number }) => void
  /** A deleted session is no reader's to keep: the connection's grant on it is dropped so renewal does not read the deletion as a revocation. */
  forgetSession?: (principal: EventDeliveryPrincipal, sessionId: string) => void
}

type Source<T> = {
  subscribe(listener: (event: T) => unknown): () => void
}

type Connection<T extends object> = {
  principal: EventDeliveryPrincipal
  push(event: T): unknown
  terminate(): unknown
  authorizedSessions: Set<string>
  /** Frames this connection was pushed; a frame decided twice for the scope is pushed once. */
  delivered: WeakSet<T>
  renewalTimer?: ReturnType<typeof setInterval>
}

type Scope<T extends object> = {
  key: string
  replayPrincipal?: EventDeliveryPrincipal
  replay: SseReplayBuffer<T>
  connections: Set<Connection<T>>
  /**
   * The ring position at the scope's last hole: a frame the ring never rang
   * (one the authority could not decide) or, for a ring that continues no
   * tombstone, the position before its start. A cursor at or below it names
   * a frame the reader may have missed, and reads as a gap whoever presents
   * it, however many connections have attached since. The start itself is
   * the ring's own: the bootstrap cursor a reader is handed on an empty ring.
   */
  holeBelow: number
  reservations: number
  /**
   * The retained ring position this scope has decided up to — delivered or
   * omitted — so a restore re-decides only what came after it. Not advanced
   * over a frame the authority could not decide, which a restore re-asks.
   */
  retainedCursor?: string
  tail: Promise<void>
  pending: boolean
  queued: number
}

export type IdentityAwareEventSource<T extends object> = {
  open(principal: EventDeliveryPrincipal): {
    replay: SseReplayBuffer<T>
    ready: Promise<void>
    subscribe(listener: (event: T) => unknown, terminate?: () => unknown): () => void
  }
  flush(): Promise<void>
  close(): void
}

export type EventDeliveryOptions<T> = {
  policy?: EventDeliveryPolicy<T>
  principal?: (context: Context) => EventDeliveryPrincipal | Promise<EventDeliveryPrincipal>
  /**
   * Where a ring that continues no tombstone starts numbering. The clock, so
   * a cursor issued by another process's ring lies below this ring's window
   * and reads as a gap; a test pins it to 0 to read ids as 1, 2, 3.
   */
  sequenceOrigin?: () => number
  /** How often a connection's grants and workspace lease are re-asked; 5 s, which a 15 s lease is rolled inside with two to spare. */
  renewalIntervalMs?: number
}

export function eventDeliveryPrincipal(context: Context): EventDeliveryPrincipal {
  const connectionId = randomUUID()
  const claims = context.get("relayHostAuth")
  if (!claims) return { mode: "unmanaged-local", connectionId }
  const credential = context.req.header("authorization")
  return {
    mode: "verified",
    connectionId,
    actorId: claims.actor_id,
    actorKind: claims.actor_kind,
    orgId: claims.org_id,
    workspaceId: claims.workspace_id,
    role: claims.role,
    ...(credential ? { credential } : {}),
  }
}

export function defaultEventDeliveryPolicy({
  principal,
  sessionId,
  actorId,
  sensitive,
}: Parameters<EventDeliveryPolicy<unknown>>[0]): EventDeliveryDecision {
  if (principal.mode === "unmanaged-local") return "deliver"
  if (!sessionId && actorId) return forActor(principal, actorId)
  if (!sessionId && !sensitive) return "deliver"
  return "omit"
}

const forActor = (principal: EventDeliveryPrincipal, actorId: string): EventDeliveryDecision =>
  principal.mode === "verified" && principal.actorId === actorId ? "deliver" : "omit"

export function sessionEventDeliveryPolicy<T>(policy: SessionAccessPolicy): EventDeliveryPolicy<T> {
  const grants = new Map<string, {
    principal: EventDeliveryPrincipal
    sessionId: string
    lease?: string
    expiresAt: number
    /** The authority granted this session to the connection at least once; only such a session is the stream's to lose. */
    granted: boolean
    denied?: boolean
    inflight?: Promise<EventDeliveryDecision>
  }>()
  const grantKey = (principal: EventDeliveryPrincipal, sessionId: string) => `${principal.connectionId}:${sessionId}`
  // Per connection: the workspace lease the unscoped arm was admitted with.
  // The request's own credential is a one-request relay host token that
  // expires within a minute; a session first seen on the connection after
  // that is authorized under this lease instead.
  const hosts = new Map<string, { lease: string; expiresAt: number; renewing?: Promise<EventDeliveryDecision> }>()
  const accessInput = (principal: EventDeliveryPrincipal, sessionId: string) => ({
    ...(principal.mode === "verified"
      ? { actor: { actorId: principal.actorId, actorKind: principal.actorKind } }
      : {}),
    ...(principal.mode === "unmanaged-local"
      ? {}
      : {
          authority: {
            managed: true as const,
            workspaceId: principal.workspaceId,
            orgId: principal.orgId,
            role: principal.role,
          },
          ...(principal.credential ? { credential: principal.credential } : {}),
        }),
    operation: "session_event_stream" as const,
    sessionId,
  })
  const authorizeGrant = async (
    principal: EventDeliveryPrincipal,
    sessionId: string,
    force = false,
  ): Promise<EventDeliveryDecision> => {
    if (principal.mode === "unmanaged-local") return "deliver"
    const key = grantKey(principal, sessionId)
    const existing = grants.get(key) ?? { principal, sessionId, expiresAt: 0, granted: false }
    grants.set(key, existing)
    const now = Date.now()
    if (!force && existing.expiresAt > now + 1_000) return existing.denied ? "omit" : "deliver"
    // A granted session whose lease lapsed while its renewal is still in
    // flight is closed on the clock, not on the authority's answer.
    if (existing.inflight) return existing.granted && existing.expiresAt <= now ? "terminate" : await existing.inflight
    const pending = (async () => {
      if (policy.sessionAuthority === "managed-private" && !policy.authorizeStream) return refusal(existing, undefined)
      const decision = policy.authorizeStream
        ? await policy.authorizeStream(accessInput(principal, sessionId), existing.lease ?? hosts.get(principal.connectionId)?.lease)
        : await policy.authorize(accessInput(principal, sessionId))
      if (!decision.allowed) return refusal(existing, decision)
      if (policy.sessionAuthority === "managed-private" && (!("lease" in decision) || typeof decision.lease !== "string" || !decision.lease.trim()
        || !("expiresAt" in decision) || typeof decision.expiresAt !== "number" || !Number.isFinite(decision.expiresAt) || decision.expiresAt <= Date.now())) {
        return refusal(existing, undefined)
      }
      existing.granted = true
      existing.denied = false
      existing.lease = "lease" in decision && typeof decision.lease === "string" ? decision.lease : undefined
      existing.expiresAt = "expiresAt" in decision && typeof decision.expiresAt === "number"
        ? Math.min(decision.expiresAt, Date.now() + SESSION_STREAM_LEASE_TTL_MS)
        : Date.now() + 5_000
      return "deliver" as const
    })().catch(() => refusal(existing, undefined)).finally(() => {
      existing.inflight = undefined
    })
    existing.inflight = pending
    return await pending
  }
  // What the authority's answer means for the stream:
  //  - a refusal of THIS session (403) is an omit, held for one cadence so a
  //    busy private session of another member's is not one round trip per
  //    delta; on a granted session it is a revocation, and renewal ends the
  //    stream on it;
  //  - the authority being away (503, a thrown call) is not an answer. On a
  //    session the reader holds a valid lease for, the lease stands until it
  //    expires. On a session the reader was never granted the frame cannot
  //    be delivered and must not be dropped in silence either — omitting it
  //    would leave the cursor contiguous over a frame the reader never saw —
  //    so the stream ends and the reconnect reads the hole as a gap. While
  //    the plane stays away that repeats once per session's first frame
  //    after each reconnect, at the authority's timeout rate: a resync per
  //    cycle, chosen over a frame lost in silence;
  //  - the reader's own credential gone (401) ends the stream.
  const refusal = (
    grant: { granted: boolean; denied?: boolean; expiresAt: number },
    decision: Extract<Awaited<ReturnType<SessionAccessPolicy["authorize"]>>, { allowed: false }> | undefined,
  ): EventDeliveryDecision => {
    if (decision && eventDecision(decision) === "omit") {
      grant.denied = true
      grant.expiresAt = Date.now() + DENIED_GRANT_TTL_MS
      return "omit"
    }
    if (isAuthorityAway(decision) && grant.granted && grant.expiresAt > Date.now()) return "deliver"
    return "terminate"
  }
  const eventPolicy: EventDeliveryPolicy<T> = async ({ principal, sessionId, actorId, sensitive }) => {
    if (principal.mode === "unmanaged-local") return "deliver"
    if (hosts.has(principal.connectionId) && await renewHost(principal) !== "deliver") return "terminate"
    if (!sessionId) {
      if (actorId) return forActor(principal, actorId)
      if (!sensitive) return "deliver"
      return "omit"
    }
    return authorizeGrant(principal, sessionId)
  }
  // The workspace lease rolls once it is inside the renewal cadence of its
  // life, so a session that first appears late still finds a live one.
  const renewHost = async (principal: EventDeliveryPrincipal): Promise<EventDeliveryDecision> => {
    const held = hosts.get(principal.connectionId)
    if (!held || !policy.authorizeHost || principal.mode === "unmanaged-local") return "deliver"
    if (held.expiresAt - Date.now() > HOST_LEASE_RENEW_WITHIN_MS) return "deliver"
    if (held.renewing) return held.expiresAt <= Date.now() ? "terminate" : await held.renewing
    held.renewing = (async () => {
      const { sessionId: _session, ...input } = accessInput(principal, "")
      const decision = await policy.authorizeHost!({ ...input, minimumRole: "viewer", lease: held.lease })
      if (!decision.allowed) {
        return isAuthorityAway(decision) && held.expiresAt > Date.now() ? "deliver" : eventDecision(decision)
      }
      if (!decision.lease?.trim() || decision.expiresAt === undefined || !Number.isFinite(decision.expiresAt) || decision.expiresAt <= Date.now()) {
        return held.expiresAt > Date.now() ? "deliver" as const : "terminate" as const
      }
      held.lease = decision.lease
      held.expiresAt = Math.min(decision.expiresAt, Date.now() + SESSION_STREAM_LEASE_TTL_MS)
      return "deliver" as const
    })().catch(() => (held.expiresAt > Date.now() ? "deliver" as const : "terminate" as const)).finally(() => {
      held.renewing = undefined
    })
    return await held.renewing
  }
  // Renewal re-asks the sessions this connection was GRANTED: one of them
  // now refused is a revocation, and ends the stream within the cadence. A
  // session it was never granted — refused, or still being asked about — is
  // not the stream's to lose: on the unscoped arm every other member's
  // private session is one. The cost is one authority round trip per
  // granted session per connection per cadence: a 15 s session lease and a
  // 10 s renewal window leave the same 5 s between re-asks whether the
  // cadence gates on the window or not.
  eventPolicy.renew = async (principal) => {
    // A session-scoped connection whose session is gone has nothing left to read.
    if (principal.mode !== "unmanaged-local" && principal.sessionScope && !grants.has(grantKey(principal, principal.sessionScope))) return "terminate"
    const current = [...grants.values()].filter((grant) => grant.principal.connectionId === principal.connectionId && grant.granted)
    const decisions = await Promise.all([
      renewHost(principal),
      ...current.map((grant) => authorizeGrant(principal, grant.sessionId, true)),
    ])
    return decisions.every((decision) => decision === "deliver") ? "deliver" : "terminate"
  }
  eventPolicy.release = (principal) => {
    hosts.delete(principal.connectionId)
    for (const [key, grant] of grants) {
      if (grant.principal.connectionId === principal.connectionId) grants.delete(key)
    }
  }
  // A lease's expiry is clamped to this clock: the plane's may lead it, and
  // a lease presented after the plane's expiry ends the stream.
  eventPolicy.holdHost = (principal, lease) => {
    hosts.set(principal.connectionId, { lease: lease.lease, expiresAt: Math.min(lease.expiresAt, Date.now() + SESSION_STREAM_LEASE_TTL_MS) })
  }
  eventPolicy.holdSession = (principal, sessionId, lease) => {
    grants.set(grantKey(principal, sessionId), {
      principal,
      sessionId,
      lease: lease.lease,
      expiresAt: Math.min(lease.expiresAt, Date.now() + SESSION_STREAM_LEASE_TTL_MS),
      granted: true,
    })
  }
  eventPolicy.forgetSession = (principal, sessionId) => {
    grants.delete(grantKey(principal, sessionId))
  }
  return eventPolicy
}

/** Renewal runs every 5 s per connection; a 15 s lease is rolled with two renewals to spare. */
const HOST_LEASE_RENEW_WITHIN_MS = 10_000
/** A refused session is held as refused for one renewal cadence. */
const DENIED_GRANT_TTL_MS = 5_000

function eventDecision(decision: Awaited<ReturnType<SessionAccessPolicy["authorize"]>>): EventDeliveryDecision {
  if (decision.allowed) return "deliver"
  return decision.status === 401 || decision.status === 503 ? "terminate" : "omit"
}

/** The authority did not answer: a 503 from it, or a call that threw. */
function isAuthorityAway(decision: { allowed: false; status: number } | undefined) {
  return decision === undefined || decision.status === 503
}

// A verified actor's scope is the actor's, at its role: what it may read is
// decided per session on every frame, so two of its connections — two tabs,
// or a reconnect whose relay host token and runtime access token were both
// re-minted (the daemon's proxy mints a runtime token per request) — share
// one ring and resume each other's cursors, and a role change opens a ring
// of its own rather than replaying the old role's frames. What one of those
// connections was granted and pushed reaches the other's replay unasked, for
// as long as a grant is held: a revocation is seen at the next renewal.
function scopeKey(principal: EventDeliveryPrincipal) {
  if (principal.mode === "unmanaged-local") return "local"
  const session = principal.sessionScope ? `:session:${principal.sessionScope}` : ""
  return `actor:${principal.orgId}:${principal.workspaceId}:${principal.actorKind}:${principal.actorId}:${principal.role}${session}`
}

/**
 * Maintains a replay sequence per authorization principal.
 *
 * A shared global sequence cannot distinguish a missing authorized event from
 * hundreds of intentionally omitted events belonging to another principal.
 * This source assigns ids only after the content-aware policy delivers an
 * event to a principal, so filtered traffic cannot punch holes in that
 * principal's cursor. Empty scopes are evicted; a reconnect reconstructs its
 * replay from the bounded retained ring using the reconnecting principal.
 * A scope is keyed by the reader's actor at its role (`scopeKey`), while
 * live authorization presents what the connection was
 * admitted with — the workspace lease its admission minted, and the session
 * leases the authority hands back — so a revoked reader is ended at the
 * next renewal whichever connection it holds.
 */
export function createIdentityAwareEventSource<T extends object>(input: {
  subscribe: Source<T>["subscribe"]
  policy: EventDeliveryPolicy<T>
  sessionId: (event: T) => string | undefined
  actorId?: (event: T) => string | undefined
  sensitive?: (event: T) => boolean
  isTerminal?: (event: T) => boolean
  maxQueuedPerScope?: number
  replayConcurrency?: number
  replayStartupDeadlineMs?: number
  sequenceOrigin?: () => number
  renewalIntervalMs?: number
}): IdentityAwareEventSource<T> {
  const maxQueuedPerScope = input.maxQueuedPerScope ?? 256
  const sequenceOrigin = input.sequenceOrigin ?? Date.now
  const replayConcurrency = input.replayConcurrency ?? 8
  const replayStartupDeadlineMs = input.replayStartupDeadlineMs ?? 10_000
  const scopes = new Map<string, Scope<T>>()
  const tombstones = new Map<string, { sequence: number; holeBelow: number; retainedCursor?: string }>()
  const retained = createSseReplayBuffer<T>(input.isTerminal ? { isTerminal: input.isTerminal } : {})
  let closed = false

  const decision = (principal: EventDeliveryPrincipal, event: T) => input.policy({
      principal,
      event,
      sessionId: input.sessionId(event),
      ...(input.actorId ? { actorId: input.actorId(event) } : {}),
      sensitive: input.sensitive?.(event) === true,
    })
  const decide = (principal: EventDeliveryPrincipal, event: T) => Promise.resolve(decision(principal, event))

  const evict = (scope: Scope<T>) => {
    if (scope.key === "local" || scope.connections.size > 0 || scope.reservations > 0) return
    if (scopes.get(scope.key) !== scope) return
    tombstones.delete(scope.key)
    tombstones.set(scope.key, {
      sequence: Number(scope.replay.lastId() ?? "0"),
      holeBelow: scope.holeBelow,
      ...(scope.retainedCursor ? { retainedCursor: scope.retainedCursor } : {}),
    })
    while (tombstones.size > 256) tombstones.delete(tombstones.keys().next().value!)
    scopes.delete(scope.key)
  }
  const disconnect = (scope: Scope<T>, connection: Connection<T>) => {
    if (!scope.connections.delete(connection)) return
    if (connection.renewalTimer) clearInterval(connection.renewalTimer)
    input.policy.release?.(connection.principal)
    void Promise.resolve().then(() => connection.terminate()).catch(() => undefined)
  }
  const apply = (
    scope: Scope<T>,
    event: T,
    decisions: Array<{ connection: Connection<T>; next: EventDeliveryDecision }>,
    replayDecision?: EventDeliveryDecision,
    decidedBefore: ReadonlySet<Connection<T>> = new Set(),
  ): Promise<void> | undefined => {
    // A policy decision may finish after the runtime has closed its store.
    // Do not resolve session ownership or publish from that retired source.
    if (closed) return undefined
    const sessionId = input.sessionId(event)
    const deliveries: Connection<T>[] = []
    const decided = new Set<Connection<T>>(decidedBefore)
    // A frame decided while the scope has a connection on the way in
    // (reserved, not yet attached) but none attached was decided for nobody:
    // the newcomer catches up from the retained position at ITS open, which
    // is past this frame. Not rung and not decided, it is a hole. The local
    // scope decides for its replay principal and rings regardless.
    let undecidable = !scope.replayPrincipal && scope.connections.size === 0 && scope.reservations > 0
    for (const result of decisions) {
      decided.add(result.connection)
      if (!scope.connections.has(result.connection)) continue
      if (result.next === "terminate") {
        // The frame is not rung for this scope's ring (it may be one the
        // connection was never allowed), so the numbering runs on over a
        // hole: no reconnect with a cursor from before it may resume through.
        undecidable = true
        scope.holeBelow = Math.max(scope.holeBelow, Number(scope.replay.lastId() ?? "0"))
        disconnect(scope, result.connection)
        continue
      }
      if (result.next === "omit") {
        if (sessionId && result.connection.authorizedSessions.has(sessionId)) disconnect(scope, result.connection)
        continue
      }
      if (sessionId) result.connection.authorizedSessions.add(sessionId)
      if (result.connection.delivered.has(event)) continue
      result.connection.delivered.add(event)
      deliveries.push(result.connection)
    }
    if (undecidable) scope.holeBelow = Math.max(scope.holeBelow, Number(scope.replay.lastId() ?? "0"))
    const delivered = deliveries.length > 0 || replayDecision === "deliver"
    // A frame reaches the scope's ring once even when it was decided twice —
    // a connection's catch-up re-enqueues a frame whose first decision was
    // still awaiting the policy when that connection attached, so that
    // connection is decided for it too.
    if (delivered && scope.replay.idFor(event) === undefined) scope.replay.push(event)
    if (!undecidable) scope.retainedCursor = retained.idFor(event) ?? scope.retainedCursor
    for (const connection of deliveries) void Promise.resolve(connection.push(event)).catch(() => undefined)
    // A connection that attached while this frame was awaiting the policy was
    // not decided for it, and its bootstrap cursor sits before the id the
    // frame just took: it is decided now — before the scope moves on to the
    // next queued frame, so that connection sees the ring's order — and the
    // frame reaches it once.
    const undecided = [...scope.connections].filter((connection) => !decided.has(connection))
    evict(scope)
    if (undecided.length > 0) return evaluate(scope, event, undecided, decided)
    return undefined
  }

  /**
   * Decide one event for a scope's connections (all of them unless named).
   * Returns `undefined` when every decision was synchronous (already applied),
   * or the promise the caller must serialize on.
   */
  const evaluate = (
    scope: Scope<T>,
    event: T,
    connections = [...scope.connections],
    decidedBefore: ReadonlySet<Connection<T>> = new Set(),
  ): Promise<void> | undefined => {
    if (closed) return undefined
    const pending = connections.map((connection) => {
      try {
        return { connection, next: decision(connection.principal, event) }
      } catch {
        return { connection, next: "terminate" as const }
      }
    })
    const replayNext = (() => {
      if (!scope.replayPrincipal) return undefined
      try {
        return decision(scope.replayPrincipal, event)
      } catch {
        return "terminate" as const
      }
    })()
    // Collected element by element rather than asserted in bulk: the
    // `instanceof` check narrows each `next`, so the settled array's type comes
    // from the check instead of from a claim about the whole array.
    const settled: Array<{ connection: Connection<T>; next: EventDeliveryDecision }> = []
    for (const item of pending) {
      if (item.next instanceof Promise) break
      settled.push({ connection: item.connection, next: item.next })
    }
    if (settled.length === pending.length && !(replayNext instanceof Promise)) {
      return apply(scope, event, settled, replayNext, decidedBefore)
    }
    return Promise.all(pending.map(async (item) => ({
      connection: item.connection,
      next: await Promise.resolve(item.next).catch(() => "terminate" as const),
    }))).then(async (decisions) => {
      const resolvedReplay = replayNext === undefined
        ? undefined
        : await Promise.resolve(replayNext).catch(() => "terminate" as const)
      await apply(scope, event, decisions, resolvedReplay, decidedBefore)
    })
  }

  // A frame this scope's ring already holds was delivered to every
  // connection attached at the time and is what a later connection's replay
  // recovers. A frame still being decided is enqueued again so the
  // connection that attached meanwhile is decided for it; `apply` pushes it
  // to no connection twice and rings it once.
  const enqueue = (scope: Scope<T>, event: T): void => {
    if (scope.replay.idFor(event) !== undefined) return
    queue(scope, event)
  }

  const queue = (scope: Scope<T>, event: T): void => {
    if (closed) return
    if (!scope.pending) {
      const result = evaluate(scope, event)
      if (!result) return
      scope.pending = true
      scope.tail = result
      void result.finally(() => {
        if (scope.tail === result) scope.pending = false
      })
      return
    }
    if (scope.queued >= maxQueuedPerScope) {
      for (const connection of scope.connections) disconnect(scope, connection)
      return
    }
    scope.queued += 1
    const tail = scope.tail.then(() => {
      scope.queued -= 1
      return evaluate(scope, event)
    })
    scope.tail = tail
    void tail.finally(() => {
      if (scope.tail === tail) scope.pending = false
    })
  }

  const requireScope = (principal: EventDeliveryPrincipal) => {
    const key = scopeKey(principal)
    const existing = scopes.get(key)
    if (existing) return existing
    const tombstone = tombstones.get(key)
    tombstones.delete(key)
    // A ring that does not continue a tombstone numbers from the origin (the
    // clock): a cursor issued by another process's ring — a runtime restart,
    // seen by a reader that reconnects after another reader already
    // re-attached — then lies below this ring's window and reads as a gap,
    // never as a resumable position in a numbering it never saw.
    const initialSequence = tombstone?.sequence ?? sequenceOrigin()
    const replay = createSseReplayBuffer<T>({
      ...(input.isTerminal ? { isTerminal: input.isTerminal } : {}),
      initialSequence,
    })
    // A cursor a reader presents to a ring that continues no tombstone came
    // from some other numbering — a scope this process evicted long ago, or
    // another process's — and only LOOKS resumable: the ring's own hole check
    // reads a cursor at its start as "nothing to replay", and the frames
    // behind it would be lost silently. So everything before the ring's
    // start is a hole: a cursor below it is a gap, and only a cursor this
    // ring issued — its start, handed out as the bootstrap cursor, included
    // — resumes. A scope restored from a tombstone continues its numbering
    // only while the retained ring still holds everything since the
    // tombstone's cursor; once that ring has rolled past it, the restored
    // ring is contiguous over a hole and the reader's cursor is a gap all the
    // same. The local scope and a runtime that has published nothing yet have
    // no numbering a cursor could have come from.
    // A tombstone names the retained position its scope had decided up to;
    // one that names none (its first retained frame was undecidable) cannot
    // say what rolled out since, and `hasGap(undefined)` is not a gap — so
    // it does not continue, and every cursor it issued reads as a gap.
    const continues = (!!tombstone && tombstone.retainedCursor !== undefined && !retained.hasGap(tombstone.retainedCursor))
      || key === "local" || retained.lastId() === undefined
    const created: Scope<T> = {
      key,
      ...(key === "local" ? { replayPrincipal: principal } : {}),
      replay,
      connections: new Set(),
      // A restore that does not continue numbers on from the tombstone, so
      // the cursor its readers hold IS the start and lies over the hole.
      holeBelow: continues ? tombstone?.holeBelow ?? 0 : tombstone ? initialSequence : initialSequence - 1,
      reservations: 0,
      retainedCursor: tombstone?.retainedCursor ?? retained.lastId(),
      tail: Promise.resolve(),
      pending: false,
      queued: 0,
    }
    scopes.set(key, created)
    const retainedEvents = retained.replayAfter(tombstone?.retainedCursor)
    if (retainedEvents.length > 0) {
      created.pending = true
      created.tail = (async () => {
        const results = Array.from({ length: retainedEvents.length }, (): EventDeliveryDecision => "omit")
        let cursor = 0
        const deadlineAt = Date.now() + replayStartupDeadlineMs
        const decideBeforeDeadline = async (event: T) => {
          const remaining = deadlineAt - Date.now()
          if (remaining <= 0) return "terminate" as const
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            return await Promise.race([
              decide(principal, event).catch(() => "terminate" as const),
              new Promise<"terminate">((resolve) => {
                timer = setTimeout(() => resolve("terminate"), remaining)
                ;(timer as { unref?: () => void }).unref?.()
              }),
            ])
          } finally {
            if (timer) clearTimeout(timer)
          }
        }
        await Promise.all(Array.from({ length: Math.min(replayConcurrency, retainedEvents.length) }, async () => {
          while (Date.now() < deadlineAt) {
            if (closed) return
            const index = cursor++
            if (index >= retainedEvents.length) return
            results[index] = await decideBeforeDeadline(retainedEvents[index].payload)
          }
        }))
        if (closed) return
        // A frame the authority could not decide — away, or past the startup
        // deadline — is not in this ring and not known to be nobody's: the
        // ring is holed up to here, so a cursor from before it reads as a gap
        // and the reader re-reads, rather than resuming over a frame it never
        // saw; a later restore re-asks from that frame on.
        let decidedThrough: string | undefined
        let holed = false
        for (let index = 0; index < retainedEvents.length; index += 1) {
          if (results[index] === "terminate") holed = true
          if (!holed) decidedThrough = retainedEvents[index].id
          if (results[index] !== "deliver") continue
          replay.push(retainedEvents[index].payload)
        }
        created.retainedCursor = decidedThrough ?? tombstone?.retainedCursor
        if (holed) created.holeBelow = Math.max(created.holeBelow, Number(replay.lastId() ?? "0"))
      })()
      void created.tail.finally(() => {
        created.pending = false
      })
    }
    created.replay = { ...replay, hasGap: (lastEventId?: string, throughId?: string) => {
      const cursor = Number(lastEventId ?? "0")
      return (cursor > 0 && cursor <= created.holeBelow) || replay.hasGap(lastEventId, throughId)
    } }
    return created
  }

  const unsubscribeSource = input.subscribe((event) => {
    if (closed) return
    retained.push(event)
    for (const scope of scopes.values()) {
      if (scope.connections.size === 0 && !scope.replayPrincipal) continue
      enqueue(scope, event)
    }
  })

  return {
    open(principal) {
      if (closed) throw new Error("Event source is closed")
      const retainedCursor = retained.lastId()
      const scope = requireScope(principal)
      const authorizedSessions = new Set<string>()
      scope.reservations += 1
      return {
        replay: scope.replay,
        ready: scope.tail,
        subscribe(listener, terminate = () => undefined) {
          if (closed) {
            input.policy.release?.(principal)
            void Promise.resolve().then(terminate).catch(() => undefined)
            return () => undefined
          }
          const connection: Connection<T> = { principal, push: listener, terminate, authorizedSessions, delivered: new WeakSet() }
          scope.connections.add(connection)
          if (input.policy.renew) {
            connection.renewalTimer = setInterval(() => {
              void Promise.resolve(input.policy.renew!(principal)).then((next) => {
                if (next !== "deliver") terminateConnection()
              }).catch(terminateConnection)
            }, input.renewalIntervalMs ?? 5_000)
            ;(connection.renewalTimer as { unref?: () => void }).unref?.()
          }
          scope.reservations -= 1
          for (const event of retained.replayAfter(retainedCursor)) enqueue(scope, event.payload)
          const terminateConnection = () => disconnect(scope, connection)
          return () => {
            if (!scope.connections.delete(connection)) return
            if (connection.renewalTimer) clearInterval(connection.renewalTimer)
            input.policy.release?.(principal)
            evict(scope)
          }
        },
      }
    },
    async flush() {
      await Promise.all([...scopes.values()].map((scope) => scope.tail))
    },
    close() {
      if (closed) return
      closed = true
      unsubscribeSource()
      for (const scope of scopes.values()) {
        for (const connection of scope.connections) disconnect(scope, connection)
      }
      scopes.clear()
      tombstones.clear()
    },
  }
}
