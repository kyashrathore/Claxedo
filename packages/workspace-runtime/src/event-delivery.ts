import { createSseReplayBuffer, type SseReplayBuffer } from "@claxedo/agent-sdk-runtime/sse"
import { createHash, randomUUID } from "node:crypto"
import type { Context } from "hono"
import type { SessionAccessPolicy } from "./session-access-policy"
import type { RelayHostAuthContext } from "./workspace-host-service-auth"

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
    }
  | {
      mode: "signed-unattributed"
      connectionId: string
      orgId: string
      workspaceId: string
      role: WorkspaceRole
      credential?: string
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
}

type Source<T> = {
  subscribe(listener: (event: T) => unknown): () => void
}

type Connection<T> = {
  principal: EventDeliveryPrincipal
  push(event: T): unknown
  terminate(): unknown
  authorizedSessions: Set<string>
  renewalTimer?: ReturnType<typeof setInterval>
}

type Scope<T> = {
  key: string
  replayPrincipal?: EventDeliveryPrincipal
  replay: SseReplayBuffer<T>
  connections: Set<Connection<T>>
  reservations: number
  retainedCursor?: string
  tail: Promise<void>
  pending: boolean
  queued: number
}

export type IdentityAwareEventSource<T> = {
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
}

export function eventDeliveryPrincipal(context: Context): EventDeliveryPrincipal {
  const connectionId = randomUUID()
  const claims = (context as unknown as { get(name: string): unknown }).get("relayHostAuth") as RelayHostAuthContext["relayHostAuth"]
  if (!claims) return { mode: "unmanaged-local", connectionId }
  if (claims.actor_id && claims.actor_kind) {
    return {
      mode: "verified",
      connectionId,
      actorId: claims.actor_id,
      actorKind: claims.actor_kind,
      orgId: claims.org_id,
      workspaceId: claims.workspace_id,
      role: claims.role,
      ...(context.req.header("authorization") ? { credential: context.req.header("authorization") } : {}),
    }
  }
  return {
    mode: "signed-unattributed",
    connectionId,
    orgId: claims.org_id,
    workspaceId: claims.workspace_id,
    role: claims.role,
    ...(context.req.header("authorization") ? { credential: context.req.header("authorization") } : {}),
  }
}

export function defaultEventDeliveryPolicy<T>({
  principal,
  sessionId,
  sensitive,
}: Parameters<EventDeliveryPolicy<T>>[0]): EventDeliveryDecision {
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
    inflight?: Promise<EventDeliveryDecision>
  }>()
  const grantKey = (principal: EventDeliveryPrincipal, sessionId: string) => `${principal.connectionId}:${sessionId}`
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
    if (!force && existing.expiresAt > Date.now() + 1_000) return "deliver"
    if (existing.inflight) return await existing.inflight
    const pending = (async () => {
      const decision = policy.authorizeStream
        ? await policy.authorizeStream(accessInput(principal, sessionId), existing.lease)
        : await policy.authorize(accessInput(principal, sessionId))
      if (!decision.allowed) return eventDecision(decision)
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
  eventPolicy.renew = async (principal) => {
    const current = [...grants.values()].filter((grant) => grant.principal.connectionId === principal.connectionId)
    if (current.length === 0) return "deliver"
    const decisions = await Promise.all(current.map((grant) => authorizeGrant(principal, grant.sessionId, true)))
    return decisions.every((decision) => decision === "deliver") ? "deliver" : "terminate"
  }
  eventPolicy.release = (principal) => {
    for (const [key, grant] of grants) {
      if (grant.principal.connectionId === principal.connectionId) grants.delete(key)
    }
  }
  return eventPolicy
}

function eventDecision(decision: Awaited<ReturnType<SessionAccessPolicy["authorize"]>>): EventDeliveryDecision {
  if (decision.allowed) return "deliver"
  return decision.status === 401 || decision.status === 503 ? "terminate" : "omit"
}

type AgentRuntimeEventDeliveryPolicy = (input: {
  identity: {
    connectionId: string
    actorId: string
    actorKind: "human" | "agent"
    orgId: string
    workspaceId: string
    role: WorkspaceRole
    credential?: string
  }
  event: { sessionId: string }
}) => "deliver" | "omit" | "terminate" | Promise<"deliver" | "omit" | "terminate">

export function agentRuntimeEventDeliveryPolicy(policy: SessionAccessPolicy): AgentRuntimeEventDeliveryPolicy {
  return async ({ identity, event }) => (await policy.authorize({
    actor: { actorId: identity.actorId, actorKind: identity.actorKind },
    authority: {
      managed: true,
      workspaceId: identity.workspaceId,
      orgId: identity.orgId,
      role: identity.role,
    },
    ...(identity.credential ? { credential: identity.credential } : {}),
    operation: "session_event_stream",
    sessionId: event.sessionId,
  })).allowed
    ? "deliver"
    : "terminate"
}

function scopeKey(principal: EventDeliveryPrincipal) {
  if (principal.mode === "unmanaged-local") return "local"
  const credential = principal.credential
    ? createHash("sha256").update(principal.credential).digest("base64url")
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
 * credential-scoped replay from the bounded retained ring using the
 * reconnecting principal. Both replay and live authorization remain bound to
 * the presenting credential, so one renewed credential cannot authorize an
 * older or revoked simultaneous connection.
 */
export function createIdentityAwareEventSource<T>(input: {
  subscribe: Source<T>["subscribe"]
  policy: EventDeliveryPolicy<T>
  sessionId: (event: T) => string | undefined
  sensitive?: (event: T) => boolean
  isTerminal?: (event: T) => boolean
  maxQueuedPerScope?: number
  replayConcurrency?: number
  replayStartupDeadlineMs?: number
}): IdentityAwareEventSource<T> {
  const maxQueuedPerScope = input.maxQueuedPerScope ?? 256
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
  ) => {
    const sessionId = input.sessionId(event)
    const deliveries: Connection<T>[] = []
    for (const result of decisions) {
      if (!scope.connections.has(result.connection)) continue
      if (result.next === "terminate") {
        disconnect(scope, result.connection)
        continue
      }
      if (result.next === "omit") {
        if (sessionId && result.connection.authorizedSessions.has(sessionId)) disconnect(scope, result.connection)
        continue
      }
      deliveries.push(result.connection)
      if (sessionId) result.connection.authorizedSessions.add(sessionId)
    }
    const delivered = deliveries.length > 0 || replayDecision === "deliver"
    if (delivered) {
      scope.replay.push(event)
      scope.retainedCursor = retained.idFor(event) ?? scope.retainedCursor
      for (const connection of deliveries) void Promise.resolve(connection.push(event)).catch(() => undefined)
    }
    evict(scope)
  }

  const evaluate = (scope: Scope<T>, event: T) => {
    const pending = [...scope.connections].map((connection) => {
      try {
        return { connection, next: decision(connection.principal, event) }
      } catch {
        return { connection, next: "terminate" as const }
      }
    })
    const replayNext = (() => {
      if (!scope.replayPrincipal) return
      try {
        return decision(scope.replayPrincipal, event)
      } catch {
        return "terminate" as const
      }
    })()
    if (!pending.some((item) => item.next instanceof Promise) && !(replayNext instanceof Promise)) {
      apply(scope, event, pending as Array<{ connection: Connection<T>; next: EventDeliveryDecision }>, replayNext)
      return
    }
    return Promise.all(pending.map(async (item) => ({
      connection: item.connection,
      next: await Promise.resolve(item.next).catch(() => "terminate" as const),
    }))).then(async (decisions) => {
      const resolvedReplay = replayNext === undefined
        ? undefined
        : await Promise.resolve(replayNext).catch(() => "terminate" as const)
      apply(scope, event, decisions, resolvedReplay)
    })
  }

  const enqueue = (scope: Scope<T>, event: T) => {
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
    const replay = createSseReplayBuffer<T>({
      ...(input.isTerminal ? { isTerminal: input.isTerminal } : {}),
      ...(tombstone ? { initialSequence: tombstone.sequence } : {}),
    })
    const connectionReplay = !tombstone && key !== "local" && retained.lastId() !== undefined
      ? { ...replay, hasGap: (lastEventId?: string, throughId?: string) =>
          Number(lastEventId ?? "0") > 0 || replay.hasGap(lastEventId, throughId) }
      : replay
    const created: Scope<T> = {
      key,
      ...(key === "local" ? { replayPrincipal: principal } : {}),
      replay: connectionReplay,
      connections: new Set(),
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
            results[index] = await decideBeforeDeadline(retainedEvents[index]!.payload)
          }
        }))
        for (let index = 0; index < retainedEvents.length; index += 1) {
          if (results[index] !== "deliver") continue
          replay.push(retainedEvents[index]!.payload)
          created.retainedCursor = retainedEvents[index]!.id
        }
      })()
      void created.tail.finally(() => {
        created.pending = false
      })
    }
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
          const connection: Connection<T> = { principal, push: listener, terminate, authorizedSessions }
          scope.connections.add(connection)
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
