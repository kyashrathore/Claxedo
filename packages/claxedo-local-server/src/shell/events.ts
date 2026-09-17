import type { Context } from "hono"
import { eventStreamResponse, type UpgradeWebSocket } from "./event-stream-response"
import { attachSseFanout, createSseReplayBuffer, type SseReplayBuffer } from "@claxedo/agent-sdk-runtime/sse"
import { controlBus, createBus, type ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { isRetainedControlPlaneEvent } from "@claxedo/server-core/platform/http/event-retention"
import {
  eventVisibleTo,
  type EventScopePrincipal,
} from "@claxedo/server-core/platform/http/event-visibility"

/**
 * Written in place of a replay when the requested cursor has fallen out of
 * the retention window, and at the head of a slow connection's queue when the
 * fanout had to shed a frame. Not a bus event: it exists per connection, and
 * the reader answers it by re-reading what this stream feeds.
 */
export type ControlPlaneStreamGapEvent = {
  type: "stream.replay-gap"
  code: "cp.sse_replay_gap"
  message: string
  severity: "warn"
  lastEventId?: string
  throughId?: string
}

export type ControlPlaneFrame = ControlPlaneEvent | ControlPlaneStreamGapEvent

/** The gap frame is per-connection and never worth a slot in the terminal ring. */
function isTerminalControlPlaneFrame(frame: ControlPlaneFrame) {
  return frame.type === "stream.replay-gap" ? false : isRetainedControlPlaneEvent(frame)
}

export type ControlPlaneEventSubscription = {
  identity:
    | { mode: "unmanaged-local"; connectionId: string }
    | {
        mode: "verified"
        connectionId: string
        actorId: string
        actorKind: "human" | "agent"
        orgId: string
        workspaceId: string
        role: string
      }
  visible(frame: ControlPlaneFrame): boolean | Promise<boolean>
}

export type ControlPlaneEventsHandlerOptions = {
  upgradeWebSocket?: UpgradeWebSocket
  resolveSubscription?: (context: Context) => ControlPlaneEventSubscription | Promise<ControlPlaneEventSubscription>
  /** Where a fresh ring starts numbering: the clock, or 0 for a test that reads ids as 1, 2, 3. */
  sequenceOrigin?: () => number
}

/**
 * Visibility for a signed subscriber: tenant-scoped notices use the same
 * subject/org predicate as the hosted event plane. A loopback subscriber sees
 * everything its own daemon publishes.
 */
export function signedControlPlaneEventVisibleTo(frame: ControlPlaneFrame, principal: EventScopePrincipal) {
  if (principal.mode !== "signed") return true
  if (frame.type === "stream.replay-gap") return true
  return eventVisibleTo(principal, frame)
}

/**
 * `/api/cp/events` — the control plane's stream, served by the local daemon
 * to its own surface and by a self-hosted node to its signed subscribers.
 *
 * It carries notices only — provision steps, worktree readiness, document
 * doorbells, share grants, a workspace's inventory change — never a
 * session's content; a session's frames are its workspace runtime's
 * `wr/events`. Every notice settles something
 * nothing re-states, so all of them sit in the terminal reserve and the
 * main ring never has to be sized for chatter.
 *
 * One process-wide ring fed by one subscription: the frames worth recovering
 * are exactly the ones published while NO connection was attached, so a
 * per-connection ring would be empty when it matters. `id:` lines +
 * `Last-Event-ID` resume; a bootstrap heartbeat carrying the resume cursor
 * written BEFORE the fanout attaches; periodic heartbeats carrying no id so a
 * frame shed from a saturated pending queue is redelivered rather than
 * skipped. A cursor-less connection is served NOTHING from the ring.
 *
 * Signed subscribers get a ring of their own, keyed by principal, filled
 * only with frames visible to them, so replay can never hand one tenant
 * another's notice or manufacture a gap for a quiet subscriber.
 */
export function createControlPlaneEventsHandler(
  bus: Pick<typeof controlBus, "subscribe"> = controlBus,
  options: ControlPlaneEventsHandlerOptions = {},
) {
  const frames = createBus<ControlPlaneFrame>()
  type Connection = {
    subscription: ControlPlaneEventSubscription
    push: (frame: ControlPlaneFrame) => unknown
    close: () => void
    /** Frames this connection was pushed; a frame decided twice for the scope is pushed once. */
    delivered: WeakSet<ControlPlaneFrame>
  }
  type Scope = {
    key: string
    replay: SseReplayBuffer<ControlPlaneFrame>
    connections: Set<Connection>
    reservations: number
    retainedCursor?: string
    tail: Promise<void>
    pending: boolean
    unknownSequence: boolean
    sharedRetained: boolean
  }
  // Numbered from the origin (the clock) so a cursor from a previous daemon
  // process lies below this ring's window and reads as a gap, not as a
  // position here.
  const sequenceOrigin = options.sequenceOrigin ?? Date.now
  const retained = createSseReplayBuffer<ControlPlaneFrame>({ isTerminal: isTerminalControlPlaneFrame, initialSequence: sequenceOrigin() })
  const scopes = new Map<string, Scope>()
  const tombstones = new Map<string, { sequence: number; retainedCursor?: string }>()
  const subscriptionKey = (subscription: ControlPlaneEventSubscription) => subscription.identity.mode === "unmanaged-local"
    ? "local"
    : JSON.stringify([
        subscription.identity.orgId,
        subscription.identity.workspaceId,
        subscription.identity.actorKind,
        subscription.identity.actorId,
      ])
  const evict = (scope: Scope) => {
    if (scope.connections.size > 0 || scope.reservations > 0) return
    if (scopes.get(scope.key) !== scope) return
    if (!scope.sharedRetained) {
      tombstones.delete(scope.key)
      tombstones.set(scope.key, {
        sequence: Number(scope.replay.lastId() ?? "0"),
        ...(scope.retainedCursor ? { retainedCursor: scope.retainedCursor } : {}),
      })
      while (tombstones.size > 256) tombstones.delete(tombstones.keys().next().value!)
    }
    scopes.delete(scope.key)
  }
  const deliver = (
    scope: Scope,
    frame: ControlPlaneFrame,
    decisions: Array<{ connection: Connection; visible: boolean }>,
    decidedBefore: ReadonlySet<Connection> = new Set(),
  ): Promise<void> | undefined => {
    let visible = false
    const decided = new Set<Connection>(decidedBefore)
    const deliveries: Connection[] = []
    for (const decision of decisions) {
      decided.add(decision.connection)
      if (!scope.connections.has(decision.connection) || !decision.visible) continue
      visible = true
      if (decision.connection.delivered.has(frame)) continue
      decision.connection.delivered.add(frame)
      deliveries.push(decision.connection)
    }
    // Rung before it is pushed: the fanout reads a live frame's id from this
    // ring as it writes it.
    if (visible && !scope.sharedRetained && scope.replay.idFor(frame) === undefined) {
      scope.replay.push(frame)
      scope.retainedCursor = retained.idFor(frame) ?? scope.retainedCursor
    }
    for (const connection of deliveries) void Promise.resolve(connection.push(frame)).catch(() => undefined)
    // A connection that attached while this frame's visibility was pending
    // was not decided for it, and its bootstrap cursor sits before the id the
    // frame just took: it is decided now — before the scope moves on to the
    // next queued frame, so that connection sees the ring's order — and the
    // frame reaches it once.
    const undecided = [...scope.connections].filter((connection) => !decided.has(connection))
    evict(scope)
    if (undecided.length > 0) return evaluate(scope, frame, undecided, decided)
    return undefined
  }
  const evaluate = (
    scope: Scope,
    frame: ControlPlaneFrame,
    connections = [...scope.connections],
    decidedBefore: ReadonlySet<Connection> = new Set(),
  ): Promise<void> | undefined => {
    const pending = connections.map((connection) => {
      try {
        return { connection, visible: connection.subscription.visible(frame) }
      } catch {
        return { connection, visible: false as const }
      }
    })
    // A synchronous verdict from every subscription is delivered inline; one
    // pending promise makes the whole batch async.
    const settled = pending.flatMap((item) =>
      typeof item.visible === "boolean" ? [{ connection: item.connection, visible: item.visible }] : [],
    )
    if (settled.length === pending.length) {
      return deliver(scope, frame, settled, decidedBefore)
    }
    return Promise.all(pending.map(async (item) => ({
      connection: item.connection,
      visible: await Promise.resolve(item.visible).catch(() => false),
    }))).then((decisions) => deliver(scope, frame, decisions, decidedBefore))
  }
  // A frame this scope's own ring already holds was delivered to every
  // connection attached at the time and is what a later connection's replay
  // recovers. The local scope's ring IS the retained ring, which holds every
  // frame before it is decided, so that scope decides each frame and relies
  // on `delivered` alone against a catch-up's second pass. A frame still
  // being decided is queued again so the connection that attached meanwhile
  // is decided for it.
  const enqueue = (scope: Scope, frame: ControlPlaneFrame) => {
    if (!scope.sharedRetained && scope.replay.idFor(frame) !== undefined) return
    queue(scope, frame)
  }
  const queue = (scope: Scope, frame: ControlPlaneFrame) => {
    if (!scope.pending) {
      const result = evaluate(scope, frame)
      if (!result) return
      scope.pending = true
      scope.tail = result
      void result.finally(() => {
        if (scope.tail === result) scope.pending = false
      })
      return
    }
    const tail = scope.tail.then(() => evaluate(scope, frame))
    scope.tail = tail
    void tail.finally(() => {
      if (scope.tail === tail) scope.pending = false
    })
  }
  const scopeFor = (subscription: ControlPlaneEventSubscription) => {
    const key = subscriptionKey(subscription)
    const existing = scopes.get(key)
    if (existing) return existing
    const tombstone = tombstones.get(key)
    tombstones.delete(key)
    const sharedRetained = subscription.identity.mode === "unmanaged-local"
    const scope: Scope = {
      key,
      replay: sharedRetained
        ? retained
        : createSseReplayBuffer<ControlPlaneFrame>({
            isTerminal: isTerminalControlPlaneFrame,
            initialSequence: tombstone?.sequence ?? sequenceOrigin(),
          }),
      connections: new Set(),
      reservations: 0,
      ...(tombstone?.retainedCursor ? { retainedCursor: tombstone.retainedCursor } : {}),
      tail: Promise.resolve(),
      pending: false,
      // Restored from a tombstone, the scope continues its numbering only
      // while the retained ring still holds everything since the tombstone's
      // cursor; past that the restored ring is contiguous over a hole.
      unknownSequence: !sharedRetained && (!tombstone || retained.hasGap(tombstone.retainedCursor)) && retained.lastId() !== undefined,
      sharedRetained,
    }
    scopes.set(key, scope)
    const retainedFrames = sharedRetained ? [] : retained.replayAfter(tombstone?.retainedCursor)
    if (retainedFrames.length > 0) {
      scope.pending = true
      scope.tail = retainedFrames.reduce(
        (tail, retainedFrame) => tail.then(async () => {
          if (await Promise.resolve(subscription.visible(retainedFrame.payload)).catch(() => false)) {
            scope.replay.push(retainedFrame.payload)
            scope.retainedCursor = retainedFrame.id
          }
        }),
        Promise.resolve(),
      )
      void scope.tail.finally(() => {
        scope.pending = false
      })
    }
    return scope
  }
  frames.subscribe((frame) => {
    retained.push(frame)
    for (const scope of scopes.values()) {
      if (scope.connections.size > 0) enqueue(scope, frame)
    }
  })
  bus.subscribe((event) => {
    frames.publish(event)
  })

  return async (c: Context) => {
    const subscription = await options.resolveSubscription?.(c) ?? {
      identity: { mode: "unmanaged-local" as const, connectionId: crypto.randomUUID() },
      visible: () => true,
    }
    const lastEventId = c.req.header("last-event-id") ?? (c.req.header("upgrade")?.toLowerCase() === "websocket" ? c.req.query("lastEventId") : undefined)
    return eventStreamResponse(c, async (stream) => {
      const retainedCursor = retained.lastId()
      const scope = scopeFor(subscription)
      scope.reservations += 1
      await scope.tail
      // `attachSseFanout` recognises its heartbeat by object identity, so the
      // sentinel must be one stable object.
      const heartbeat = { type: "heartbeat" } as const
      const cursor = lastEventId ?? scope.replay.lastId() ?? "0"
      const replay = scope.unknownSequence && Number(lastEventId ?? "0") > 0
        ? { ...scope.replay, hasGap: () => true }
        : scope.replay

      await stream
        .writeSSE({ id: cursor, data: JSON.stringify(heartbeat) })
        .catch(() => {})

      const cleanup = attachSseFanout<ControlPlaneFrame>({
        subscribe: (listener) => {
          const close = () => stream.abort()
          const connection: Connection = { subscription, push: listener, close, delivered: new WeakSet() }
          scope.connections.add(connection)
          // A cursor presented from here on is this scope's own numbering.
          scope.unknownSequence = false
          scope.reservations -= 1
          for (const retainedFrame of retained.replayAfter(retainedCursor)) enqueue(scope, retainedFrame.payload)
          return () => {
            scope.connections.delete(connection)
            evict(scope)
          }
        },
        // Visibility is decided before a frame reaches a connection: live
        // frames in `deliver`, replayed frames when the scope's own ring was
        // filled. Nothing invisible can arrive here.
        write: (frame, meta) => {
          return stream.writeSSE({
            ...(meta?.id ? { id: meta.id } : {}),
            data: JSON.stringify(frame),
          })
        },
        heartbeat,
        heartbeatMs: 5_000,
        lastEventId: cursor,
        replay,
        replayLive: false,
        replayGap: ({ lastEventId, throughId }) => ({
          type: "stream.replay-gap",
          code: "cp.sse_replay_gap",
          message: "Control plane event replay cursor is no longer available; refetch project and workspace state.",
          severity: "warn",
          ...(lastEventId ? { lastEventId } : {}),
          ...(throughId ? { throughId } : {}),
        }),
      })

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          cleanup()
          resolve()
        })
      })
    }, options.upgradeWebSocket)
  }
}
