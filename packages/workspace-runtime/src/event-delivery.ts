import { createSseReplayBuffer, type SseReplayBuffer } from "@claxedo/agent-sdk-runtime/sse"
import { randomUUID } from "node:crypto"
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

export type EventDeliveryPolicy<T> = (input: {
  principal: EventDeliveryPrincipal
  event: T
  sessionId?: string
  sensitive: boolean
}) => EventDeliveryDecision | Promise<EventDeliveryDecision>

type Source<T> = {
  subscribe(listener: (event: T) => unknown): () => void
}

type Connection<T> = {
  principal: EventDeliveryPrincipal
  push(event: T): unknown
  terminate(): unknown
  authorizedSessions: Set<string>
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
  return ({ principal, sessionId, sensitive }) => {
    if (principal.mode === "unmanaged-local") return "deliver"
    if (!sessionId) {
      if (!sensitive) return "deliver"
      return "omit"
    }
    const context = {
      ...(principal.mode === "verified"
        ? { actor: { actorId: principal.actorId, actorKind: principal.actorKind } }
        : {}),
      authority: {
        managed: true as const,
        workspaceId: principal.workspaceId,
        orgId: principal.orgId,
        role: principal.role,
      },
      ...(principal.credential ? { credential: principal.credential } : {}),
    }
    const decision = policy.authorize({
      ...context,
      operation: "session_event_stream",
      sessionId,
    })
    if (decision instanceof Promise) return decision.then(eventDecision)
    return eventDecision(decision)
  }
}

function eventDecision(decision: Awaited<ReturnType<SessionAccessPolicy["authorize"]>>): EventDeliveryDecision {
  if (decision.allowed) return "deliver"
  return decision.code === "session_authority_proof_invalid" ? "terminate" : "omit"
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
  if (principal.mode === "signed-unattributed") {
    return `unattributed:${principal.orgId}:${principal.workspaceId}:${principal.role}`
  }
  return `actor:${principal.orgId}:${principal.workspaceId}:${principal.actorKind}:${principal.actorId}`
}

/**
 * Maintains a replay sequence per authorization principal.
 *
 * A shared global sequence cannot distinguish a missing authorized event from
 * hundreds of intentionally omitted events belonging to another principal.
 * This source assigns ids only after the content-aware policy delivers an
 * event to a principal, so filtered traffic cannot punch holes in that
 * principal's cursor. Empty scopes are evicted; a reconnect reconstructs its
 * actor-scoped replay from the bounded retained ring using the reconnecting
 * principal. Live authorization remains connection-scoped so one renewed
 * credential cannot authorize an older simultaneous connection.
 */
export function createIdentityAwareEventSource<T>(input: {
  subscribe: Source<T>["subscribe"]
  policy: EventDeliveryPolicy<T>
  sessionId: (event: T) => string | undefined
  sensitive?: (event: T) => boolean
  isTerminal?: (event: T) => boolean
}): IdentityAwareEventSource<T> {
  const scopes = new Map<string, Scope<T>>()
  const tombstones = new Map<string, { sequence: number; retainedCursor?: string }>()
  const retained = createSseReplayBuffer<T>({ ...(input.isTerminal ? { isTerminal: input.isTerminal } : {}) })

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
  const terminate = (scope: Scope<T>, connection: Connection<T>) => {
    scope.connections.delete(connection)
    void Promise.resolve(connection.terminate()).catch(() => undefined)
  }
  const apply = (
    scope: Scope<T>,
    event: T,
    decisions: Array<{ connection: Connection<T>; next: EventDeliveryDecision }>,
    replayDecision?: EventDeliveryDecision,
  ) => {
    const sessionId = input.sessionId(event)
    let delivered = false
    for (const result of decisions) {
      if (!scope.connections.has(result.connection)) continue
      if (result.next === "terminate") {
        terminate(scope, result.connection)
        continue
      }
      if (result.next === "omit") {
        if (sessionId && result.connection.authorizedSessions.has(sessionId)) terminate(scope, result.connection)
        continue
      }
      delivered = true
      if (sessionId) result.connection.authorizedSessions.add(sessionId)
      void Promise.resolve(result.connection.push(event)).catch(() => undefined)
    }
    if (!delivered && replayDecision === "deliver") delivered = true
    if (delivered) {
      scope.replay.push(event)
      scope.retainedCursor = retained.idFor(event) ?? scope.retainedCursor
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
    const tail = scope.tail.then(() => evaluate(scope, event))
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
    }
    scopes.set(key, created)
    const retainedEvents = retained.replayAfter(tombstone?.retainedCursor)
    if (retainedEvents.length > 0) {
      created.pending = true
      created.tail = retainedEvents.reduce(
        (tail, event) => tail.then(async () => {
          if (await decide(principal, event.payload).catch(() => "terminate" as const) === "deliver") {
            replay.push(event.payload)
            created.retainedCursor = event.id
          }
        }),
        Promise.resolve(),
      )
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
          const connection = { principal, push: listener, terminate, authorizedSessions }
          scope.connections.add(connection)
          scope.reservations -= 1
          for (const event of retained.replayAfter(retainedCursor)) enqueue(scope, event.payload)
          return () => {
            scope.connections.delete(connection)
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
        for (const connection of scope.connections) connection.terminate()
        scope.connections.clear()
      }
      scopes.clear()
      tombstones.clear()
    },
  }
}
