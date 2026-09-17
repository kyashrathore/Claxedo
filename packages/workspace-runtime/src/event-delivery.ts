import { createSseReplayBuffer, type SseReplayBuffer } from "@claxedo/agent-sdk-runtime/sse"
import { createHash, randomUUID } from "node:crypto"
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
      /** What the reader's replay scope is keyed by when it is not the credential itself. */
      replayKey?: string
    }
  | {
      mode: "signed-unattributed"
      connectionId: string
      orgId: string
      workspaceId: string
      role: WorkspaceRole
      credential?: string
      replayKey?: string
    }

export type EventDeliveryDecision = "deliver" | "omit" | "terminate"

export type EventDeliveryPolicy<T> = ((input: {
  principal: EventDeliveryPrincipal
  event: T
  sessionId?: string
  sensitive: boolean
}) => EventDeliveryDecision | Promise<EventDeliveryDecision>) & {
  renew?: (principal: EventDeliveryPrincipal) => EventDeliveryDecision | Promise<EventDeliveryDecision>
  release?: (principal: EventDeliveryPrincipal) => void
  /** The workspace stream lease a connection was admitted with; presented for every session it first sees. */
  holdHost?: (principal: EventDeliveryPrincipal, lease: { lease: string; expiresAt: number }) => void
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
  /** A connection has attached since this scope was created without a tombstone. */
  attached: boolean
  reservations: number
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
    decide(event: T): Promise<EventDeliveryDecision>
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
}

export function eventDeliveryPrincipal(context: Context): EventDeliveryPrincipal {
  const connectionId = randomUUID()
  const claims = context.get("relayHostAuth")
  if (!claims) return { mode: "unmanaged-local", connectionId }
  const credential = context.req.header("authorization")
  // What a reader's replay scope is keyed by, beside its actor. Through the
  // relay, the runtime access token: the relay mints a fresh one-request host
  // token per connection from it, so keyed by the host token every reconnect
  // would be a stranger's. Stamped in process (the daemon's own boundary
  // verified the actor, and the browser's cookie is no header here), the
  // actor alone: there is no credential to bind a scope to.
  const replayKey = "parent_jti" in claims && claims.parent_jti
    ? `rat:${claims.parent_jti}`
    : "principal_kind" in claims
      ? "embedded"
      : undefined
  if (claims.actor_id && claims.actor_kind) {
    return {
      mode: "verified",
      connectionId,
      actorId: claims.actor_id,
      actorKind: claims.actor_kind,
      orgId: claims.org_id,
      workspaceId: claims.workspace_id,
      role: claims.role,
      ...(credential ? { credential } : {}),
      ...(replayKey ? { replayKey } : {}),
    }
  }
  return {
    mode: "signed-unattributed",
    connectionId,
    orgId: claims.org_id,
    workspaceId: claims.workspace_id,
    role: claims.role,
    ...(credential ? { credential } : {}),
    ...(replayKey ? { replayKey } : {}),
  }
}

export function defaultEventDeliveryPolicy({
  principal,
  sessionId,
  sensitive,
}: Parameters<EventDeliveryPolicy<unknown>>[0]): EventDeliveryDecision {
  if (principal.mode === "unmanaged-local") return "deliver"
  if (!sessionId && !sensitive) return "deliver"
  return principal.mode === "signed-unattributed" ? "terminate" : "omit"
}

export function sessionEventDeliveryPolicy<T>(policy: SessionAccessPolicy): EventDeliveryPolicy<T> {
  const grants = new Map<string, {
    principal: EventDeliveryPrincipal
    sessionId: string
    lease?: string
    expiresAt: number
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
    const existing = grants.get(key) ?? { principal, sessionId, expiresAt: 0 }
    grants.set(key, existing)
    if (!force && existing.expiresAt > Date.now() + 1_000) return existing.denied ? "omit" : "deliver"
    if (existing.inflight) return await existing.inflight
    const pending = (async () => {
      const decision = policy.authorizeStream
        ? await policy.authorizeStream(accessInput(principal, sessionId), existing.lease ?? hosts.get(principal.connectionId)?.lease)
        : await policy.authorize(accessInput(principal, sessionId))
      if (!decision.allowed) {
        const next = eventDecision(decision)
        // A session the reader may not read streams on regardless: its every
        // delta would be one authority round trip, and a scope whose queue
        // fills with those is torn down. The refusal is held for as long as a
        // grant would be, and the renewal cadence re-asks.
        if (next === "omit") {
          existing.denied = true
          existing.expiresAt = Date.now() + DENIED_GRANT_TTL_MS
        }
        return next
      }
      existing.denied = false
      existing.lease = "lease" in decision && typeof decision.lease === "string" ? decision.lease : undefined
      existing.expiresAt = "expiresAt" in decision && typeof decision.expiresAt === "number"
        ? decision.expiresAt
        : Date.now() + 5_000
      return "deliver" as const
    })().catch(() => "terminate" as const).finally(() => {
      existing.inflight = undefined
    })
    existing.inflight = pending
    return await pending
  }
  const eventPolicy: EventDeliveryPolicy<T> = ({ principal, sessionId, sensitive }) => {
    if (principal.mode === "unmanaged-local") return "deliver"
    if (!sessionId) {
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
    if (held.renewing) return await held.renewing
    held.renewing = (async () => {
      const { sessionId: _session, ...input } = accessInput(principal, "")
      const decision = await policy.authorizeHost!({ ...input, minimumRole: "viewer", lease: held.lease })
      if (!decision.allowed) return eventDecision(decision)
      if (decision.lease && decision.expiresAt !== undefined) {
        held.lease = decision.lease
        held.expiresAt = Math.min(decision.expiresAt, Date.now() + SESSION_STREAM_LEASE_TTL_MS)
      }
      return "deliver" as const
    })().catch(() => "terminate" as const).finally(() => {
      held.renewing = undefined
    })
    return await held.renewing
  }
  // Renewal re-asks the sessions this connection was DELIVERED: one of them
  // now refused is a revocation, and ends the stream. A session it was never
  // delivered is not the stream's to lose — on the unscoped arm every other
  // member's private session is one — and is re-asked only when its hold
  // lapses and it next frames.
  eventPolicy.renew = async (principal) => {
    const current = [...grants.values()].filter((grant) => grant.principal.connectionId === principal.connectionId && !grant.denied)
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
  // The lease's expiry is clamped to this clock: the plane's may lead it,
  // and a lease presented after the plane's expiry ends the stream.
  eventPolicy.holdHost = (principal, lease) => {
    hosts.set(principal.connectionId, { lease: lease.lease, expiresAt: Math.min(lease.expiresAt, Date.now() + SESSION_STREAM_LEASE_TTL_MS) })
  }
  return eventPolicy
}

/** Renewal runs every 5 s per connection; a 15 s lease is rolled with two renewals to spare. */
const HOST_LEASE_RENEW_WITHIN_MS = 10_000
/** A refused session is not re-asked before the next renewal would re-ask it anyway. */
const DENIED_GRANT_TTL_MS = 5_000

function eventDecision(decision: Awaited<ReturnType<SessionAccessPolicy["authorize"]>>): EventDeliveryDecision {
  if (decision.allowed) return "deliver"
  return decision.status === 401 || decision.status === 503 ? "terminate" : "omit"
}

function scopeKey(principal: EventDeliveryPrincipal) {
  if (principal.mode === "unmanaged-local") return "local"
  const key = principal.replayKey ?? principal.credential
  const credential = key
    ? createHash("sha256").update(key).digest("base64url")
    : `connection:${principal.connectionId}`
  if (principal.mode === "signed-unattributed") {
    return `unattributed:${principal.orgId}:${principal.workspaceId}:${principal.role}:${credential}`
  }
  return `actor:${principal.orgId}:${principal.workspaceId}:${principal.actorKind}:${principal.actorId}:${credential}`
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
 * A scope is keyed by the reader's durable identity (the runtime access
 * token behind the relay's per-request host tokens, or the in-process
 * actor), while live authorization presents what the connection was
 * admitted with — the workspace lease its admission minted, and the session
 * leases the authority hands back — so a revoked reader is ended at the
 * next renewal whichever connection it holds.
 */
export function createIdentityAwareEventSource<T extends object>(input: {
  subscribe: Source<T>["subscribe"]
  policy: EventDeliveryPolicy<T>
  sessionId: (event: T) => string | undefined
  sensitive?: (event: T) => boolean
  isTerminal?: (event: T) => boolean
  maxQueuedPerScope?: number
  replayConcurrency?: number
  replayStartupDeadlineMs?: number
  sequenceOrigin?: () => number
}): IdentityAwareEventSource<T> {
  const maxQueuedPerScope = input.maxQueuedPerScope ?? 256
  const sequenceOrigin = input.sequenceOrigin ?? Date.now
  const replayConcurrency = input.replayConcurrency ?? 8
  const replayStartupDeadlineMs = input.replayStartupDeadlineMs ?? 10_000
  const scopes = new Map<string, Scope<T>>()
  const tombstones = new Map<string, { sequence: number; retainedCursor?: string }>()
  const retained = createSseReplayBuffer<T>(input.isTerminal ? { isTerminal: input.isTerminal } : {})

  const decision = (principal: EventDeliveryPrincipal, event: T) => input.policy({
      principal,
      event,
      sessionId: input.sessionId(event),
      sensitive: input.sensitive?.(event) === true,
    })
  const decide = (principal: EventDeliveryPrincipal, event: T) => Promise.resolve(decision(principal, event))

  const evict = (scope: Scope<T>) => {
    if (scope.key === "local" || scope.connections.size > 0 || scope.reservations > 0) return
    if (scopes.get(scope.key) !== scope) return
    tombstones.delete(scope.key)
    tombstones.set(scope.key, {
      sequence: Number(scope.replay.lastId() ?? "0"),
      ...(scope.retainedCursor ? { retainedCursor: scope.retainedCursor } : {}),
    })
    while (tombstones.size > 256) tombstones.delete(tombstones.keys().next().value!)
    scopes.delete(scope.key)
  }
  const disconnect = (scope: Scope<T>, connection: Connection<T>) => {
    scope.connections.delete(connection)
    if (connection.renewalTimer) clearInterval(connection.renewalTimer)
    input.policy.release?.(connection.principal)
    void Promise.resolve(connection.terminate()).catch(() => undefined)
  }
  const apply = (
    scope: Scope<T>,
    event: T,
    decisions: Array<{ connection: Connection<T>; next: EventDeliveryDecision }>,
    replayDecision?: EventDeliveryDecision,
    decidedBefore: ReadonlySet<Connection<T>> = new Set(),
  ): Promise<void> | undefined => {
    const sessionId = input.sessionId(event)
    const deliveries: Connection<T>[] = []
    const decided = new Set<Connection<T>>(decidedBefore)
    for (const result of decisions) {
      decided.add(result.connection)
      if (!scope.connections.has(result.connection)) continue
      if (result.next === "terminate") {
        // The frame is not rung for this scope's ring (it may be one the
        // connection was never allowed), so the numbering runs on over a
        // hole: the connection's reconnect must not resume through it.
        scope.attached = false
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
    const delivered = deliveries.length > 0 || replayDecision === "deliver"
    // A frame reaches the scope's ring once even when it was decided twice —
    // a connection's catch-up re-enqueues a frame whose first decision was
    // still awaiting the policy when that connection attached, so that
    // connection is decided for it too.
    if (delivered && scope.replay.idFor(event) === undefined) {
      scope.replay.push(event)
      scope.retainedCursor = retained.idFor(event) ?? scope.retainedCursor
    }
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
    const replay = createSseReplayBuffer<T>({
      ...(input.isTerminal ? { isTerminal: input.isTerminal } : {}),
      initialSequence: tombstone?.sequence ?? sequenceOrigin(),
    })
    // A scope created without a tombstone numbers its ring from 1 (from the
    // retained ring), so a cursor a reader presents to it came from some other
    // numbering — a scope this process evicted long ago, or one keyed by a
    // credential the relay has since re-minted — and only LOOKS resumable:
    // the ring's own hole check would read it as "nothing to replay" and the
    // frames behind it would be lost silently. Until a connection has attached
    // to this scope, every positive cursor is a gap. Once one has, a cursor is
    // this scope's own numbering, and the ring's hole check decides. A scope
    // restored from a tombstone continues its numbering only while the
    // retained ring still holds everything since the tombstone's cursor; once
    // that ring has rolled past it, the restored ring is contiguous over a
    // hole and the reader's cursor is a gap all the same.
    const created: Scope<T> = {
      key,
      ...(key === "local" ? { replayPrincipal: principal } : {}),
      replay,
      connections: new Set(),
      attached: (!!tombstone && !retained.hasGap(tombstone.retainedCursor)) || key === "local" || retained.lastId() === undefined,
      reservations: 0,
      ...(tombstone?.retainedCursor ? { retainedCursor: tombstone.retainedCursor } : {}),
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
            const index = cursor++
            if (index >= retainedEvents.length) return
            results[index] = await decideBeforeDeadline(retainedEvents[index].payload)
          }
        }))
        for (let index = 0; index < retainedEvents.length; index += 1) {
          if (results[index] !== "deliver") continue
          replay.push(retainedEvents[index].payload)
          created.retainedCursor = retainedEvents[index].id
        }
      })()
      void created.tail.finally(() => {
        created.pending = false
      })
    }
    // Consulted at every open, not only for a scope created unattached: a
    // `terminate` decision later takes `attached` down again (a frame the
    // ring never rang), and the next reconnect must read that as a gap.
    created.replay = { ...replay, hasGap: (lastEventId?: string, throughId?: string) =>
      (!created.attached && Number(lastEventId ?? "0") > 0) || replay.hasGap(lastEventId, throughId) }
    return created
  }

  const unsubscribeSource = input.subscribe((event) => {
    retained.push(event)
    for (const scope of scopes.values()) {
      if (scope.connections.size === 0 && !scope.replayPrincipal) continue
      enqueue(scope, event)
    }
  })

  return {
    open(principal) {
      const retainedCursor = retained.lastId()
      const scope = requireScope(principal)
      const authorizedSessions = new Set<string>()
      scope.reservations += 1
      return {
        replay: scope.replay,
        ready: scope.tail,
        subscribe(listener, terminate = () => undefined) {
          // Replay is already filtered into this principal-scoped buffer. Mark
          // its session ids as delivered for the new connection as well, so a
          // later live denial is treated as revocation and tears the stream
          // down. Without this, reconnecting participants could retain a live
          // stream after their access was removed because only live delivery
          // populated `authorizedSessions`.
          for (const retainedEvent of scope.replay.replayAfter(undefined)) {
            const sessionId = input.sessionId(retainedEvent.payload)
            if (sessionId) authorizedSessions.add(sessionId)
          }
          const connection: Connection<T> = { principal, push: listener, terminate, authorizedSessions, delivered: new WeakSet() }
          scope.connections.add(connection)
          scope.attached = true
          if (input.policy.renew) {
            connection.renewalTimer = setInterval(() => {
              void Promise.resolve(input.policy.renew!(principal)).then((next) => {
                if (next !== "deliver") terminateConnection()
              }).catch(terminateConnection)
            }, 5_000)
            ;(connection.renewalTimer as { unref?: () => void }).unref?.()
          }
          scope.reservations -= 1
          for (const event of retained.replayAfter(retainedCursor)) enqueue(scope, event.payload)
          const terminateConnection = () => disconnect(scope, connection)
          return () => {
            scope.connections.delete(connection)
            if (connection.renewalTimer) clearInterval(connection.renewalTimer)
            input.policy.release?.(principal)
            evict(scope)
          }
        },
        async decide(event) {
          const next = await decide(principal, event)
          const sessionId = input.sessionId(event)
          if (next === "deliver" && sessionId) authorizedSessions.add(sessionId)
          if (next === "omit" && sessionId && authorizedSessions.has(sessionId)) return "terminate"
          return next
        },
      }
    },
    async flush() {
      await Promise.all([...scopes.values()].map((scope) => scope.tail))
    },
    close() {
      unsubscribeSource()
      for (const scope of scopes.values()) {
        for (const connection of scope.connections) {
          if (connection.renewalTimer) clearInterval(connection.renewalTimer)
          input.policy.release?.(connection.principal)
          connection.terminate()
        }
        scope.connections.clear()
      }
      scopes.clear()
      tombstones.clear()
    },
  }
}
