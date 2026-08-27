import { randomUUID } from "crypto"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import { attachSseFanout, createSseReplayBuffer, type SseReplayBuffer } from "@claxedo/agent-sdk-runtime/sse"
import { claxedoBus, createBus, globalBus, type ClaxedoEvent, type GlobalEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { isTerminalClaxedoEvent } from "@claxedo/server-core/platform/http/event-retention"
import {
  eventVisibleTo,
  type EventScopePrincipal,
} from "@claxedo/server-core/platform/http/event-visibility"

/** A `globalBus` envelope after `normalizeGlobalEvent` has filled in its defaults. */
type NormalizedGlobalEvent = {
  directory: string
  payload: { id: string; type?: string; properties: Record<string, unknown> }
}

/**
 * Synthetic frame written in place of a replay when the requested cursor has
 * already fallen out of the retention window. Same shape as the sibling streams
 * (`routes/events.ts`, `workspace-runtime/src/routes/runtime-events.ts`) so a
 * consumer learns ONE frame; claxedo-app currently no-ops on it (its emitter
 * dispatches by `type` and ignores unregistered ones), which is the correct
 * degradation until a consumer opts into refetching on it.
 */
export type GlobalStreamGapEvent = {
  type: "stream.replay-gap"
  code: "global.sse_replay_gap"
  message: string
  severity: "warn"
  lastEventId?: string
  throughId?: string
}

/**
 * Everything this stream can write. Two wire shapes, deliberately: `globalBus`
 * frames stay wrapped in `{directory, payload}` (the native-opencode compat
 * envelope) and `claxedoBus` frames stay flat, because `ClaxedoEventsProvider`'s
 * `isClaxedoEvent` guard requires a top-level `.type` for the latter.
 */
export type CentralFrame = NormalizedGlobalEvent | ClaxedoEvent | GlobalStreamGapEvent

/** The per-connection handshake/heartbeat wire frame, unchanged from before replay. */
type ConnectedFrame = {
  directory: string
  payload: { id: string; type: "server.connected"; properties: Record<string, unknown> }
}

export function connectedFrame(): ConnectedFrame {
  return {
    directory: "global",
    payload: { id: randomUUID(), type: "server.connected", properties: {} },
  }
}

/**
 * Frames whose loss is not self-healing, so `createSseReplayBuffer` keeps them
 * in a second, independent ring that the chatty frames cannot evict.
 *
 * Flat bus frames delegate to the shared central policy in `./event-retention`
 * — this handler and `routes/events.ts` read the same `claxedoBus`, so they must
 * not disagree about what is protected. Compat envelopes add
 * `isTerminalCompatEvent`'s set from `@claxedo/agent-sdk-runtime/compat-events`
 * (`session.idle` / `session.error`), inlined rather than imported because the
 * bridged payload here is typed `{type?: string}` — `globalBus` accepts anything
 * the native engine emits — so calling the typed predicate would need a cast
 * that asserts more than is known.
 */
function isTerminalCentralFrame(frame: CentralFrame) {
  if (!("type" in frame)) {
    return frame.payload.type === "session.idle" || frame.payload.type === "session.error"
  }
  return frame.type === "stream.replay-gap" ? false : isTerminalClaxedoEvent(frame)
}

function normalizeGlobalEvent(event: GlobalEvent): NormalizedGlobalEvent {
  const payload = event.payload as typeof event.payload & { id?: unknown }
  return {
    ...event,
    directory: event.directory ?? "global",
    payload: {
      id: typeof payload.id === "string" ? payload.id : randomUUID(),
      properties: {},
      ...event.payload,
    },
  }
}

type GlobalEventsBuses = {
  globalBus: Pick<typeof globalBus, "subscribe">
  claxedoBus: Pick<typeof claxedoBus, "subscribe">
}

export type GlobalEventSubscription = {
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
  visible(frame: CentralFrame): boolean | Promise<boolean>
}

export type GlobalEventsHandlerOptions = {
  resolveSubscription?: (context: Context) => GlobalEventSubscription | Promise<GlobalEventSubscription>
}

export function globalEventSessionId(frame: CentralFrame) {
  if (!("type" in frame)) {
    const properties = frame.payload.properties
    if (typeof properties.sessionID === "string") return properties.sessionID
    const info = properties.info && typeof properties.info === "object" && !Array.isArray(properties.info)
      ? properties.info as Record<string, unknown>
      : undefined
    if (frame.payload.type === "session.updated" && typeof info?.id === "string") return info.id
    if (typeof info?.sessionID === "string") return info.sessionID
    const part = properties.part && typeof properties.part === "object" && !Array.isArray(properties.part)
      ? properties.part as Record<string, unknown>
      : undefined
    if (typeof part?.sessionID === "string") return part.sessionID
    return undefined
  }
  if (frame.type === "session.lifecycle") return frame.sessionID
  if (frame.type === "agent.lifecycle") return frame.sessionId
  return undefined
}

/**
 * Canonical visibility for a signed subscriber on the process-global compat
 * stream. Session frames are checked by the session authority supplied by the
 * caller; tenant-scoped Claxedo events use the same subject/org predicate as
 * the hosted event plane. Wrapped native events without a session identity are
 * deliberately denied because their arbitrary properties carry no trusted
 * tenant scope.
 */
export async function signedGlobalEventVisibleTo(
  frame: CentralFrame,
  principal: EventScopePrincipal,
  authorizeSession?: (sessionId: string) => boolean | Promise<boolean>,
) {
  if (principal.mode !== "signed") return true
  if ("type" in frame && frame.type === "stream.replay-gap") return true
  const sessionId = globalEventSessionId(frame)
  if (sessionId) return authorizeSession ? await authorizeSession(sessionId) : false
  if (!("type" in frame)) return false
  return eventVisibleTo(principal, frame)
}

/**
 * The central `/global/event` + `/api/wr/events` stream (local/desktop mode).
 *
 * `claxedoBus` (aka `workspaceRuntimeBus`) carries events that never touch
 * `globalBus` — most importantly `session.lifecycle`, the ONLY notification a
 * non-opencode/harness (ACP) session's `POST /session` emits (see
 * `packages/workspace-runtime/src/routes/session-core.ts`'s `.post("/session")`,
 * which calls `publishSessionLifecycle`, never `publishGlobal`). Local/unsigned
 * workspaces never open a workspace-scoped `/api/wr/events` connection
 * (`claxedoEventStreamTargets` in
 * `packages/claxedo-app/src/app/integrations/claxedo-events.tsx` only adds that
 * target for `cloud`/`user-hosted` workspace kinds) — this central stream is
 * their ONLY channel.
 *
 * ## Why one normalizing bus in front of the ring
 *
 * `normalizeGlobalEvent` mints a `randomUUID()` for envelopes that arrive
 * without a `payload.id`. Normalizing per connection would give the same bus
 * event a DIFFERENT body on every connection and on every replay, and would
 * defeat `replay.idFor` (a WeakMap keyed on object identity) so live frames
 * would be re-pushed under a second id. Normalizing ONCE, upstream of both the
 * ring and the fanout, makes each frame a single object with one `id:` that is
 * byte-identical live and on replay. The `frames.subscribe` that feeds the ring
 * is registered before any connection's fanout, so by the time a connection
 * sees a frame the ring has already assigned its id.
 *
 * ## Buffer / cursor semantics
 *
 * Mirrors `runtimeBusEventsHandler`
 * (`packages/workspace-runtime/src/routes/runtime-events.ts`): one process-wide
 * ring fed by one subscription (the frames worth recovering are exactly the ones
 * published while NO connection was attached, so a per-connection ring would be
 * empty when it matters), `id:` lines + `Last-Event-ID` resume, a bootstrap
 * handshake carrying the resume cursor written BEFORE the fanout attaches, and
 * periodic handshakes carrying no id so a frame shed from a saturated pending
 * queue is redelivered rather than skipped.
 *
 * A cursor-less connection is served NOTHING from the ring. That matters more
 * here than anywhere else: this is the stream that carries `permission.asked` /
 * `question.asked` compat envelopes, and claxedo-app applies them to the shell
 * caches, so a full re-read on every reconnect resurrects permission and
 * question docks the user already answered.
 *
 * ## Identity-aware compatibility delivery
 *
 * Compat envelopes contain transcript events, so route authentication alone is
 * insufficient for private sessions. The caller supplies one content-aware
 * visibility predicate backed by the session authority. It is applied before a
 * frame receives a per-principal cursor id and again at the final live/replay
 * write. Another principal's traffic therefore cannot leak through replay or
 * manufacture a replay-gap notice for a quiet subscriber.
 */
export function createGlobalEventsHandler(
  buses: GlobalEventsBuses = { globalBus, claxedoBus },
  options: GlobalEventsHandlerOptions = {},
) {
  const frames = createBus<CentralFrame>()
  // Retention stays at the shared 256 + 64 even though this bus IS chattier
  // than the workspace one: `server.ts` bridges the embedded native-opencode
  // engine's ENTIRE `/global/event` stream onto `globalBus` unfiltered
  // (`upstreamEvents.on`), so token-level `message.part.updated` frames ride
  // here. Growing the main ring is the wrong answer to that:
  //
  //  - `message.part.updated` carries the WHOLE part, not a delta, so its
  //    payload grows with the message. A 1024-frame ring of a long streaming
  //    response is tens of MB pinned for the process lifetime, and this handler
  //    runs in the desktop app.
  //  - Those are also the frames that self-heal — a missed part is reconciled by
  //    the next message refetch — while the ones that DON'T self-heal
  //    (`session.lifecycle`, doorbells, settlements) are rare and live in the
  //    terminal ring, which no amount of delta chatter can evict. That second
  //    ring, not a bigger first one, is the right lever for this profile.
  //  - The sibling compat stream over the same envelope traffic
  //    (`globalEventReplay` in `packages/workspace-runtime/src/workspace/runtime.ts`)
  //    already runs at 256; matching it keeps one number to reason about.
  //
  // The cost is that a reconnect mid-stream can land on a replay-gap notice
  // instead of a replay. That degrades to the pre-fix behaviour for delta
  // frames only, which is safe.
  type Connection = {
    subscription: GlobalEventSubscription
    push: (frame: CentralFrame) => unknown
    close: () => void
    authorizedSessions: Set<string>
  }
  type Scope = {
    key: string
    replay: SseReplayBuffer<CentralFrame>
    connections: Set<Connection>
    reservations: number
    retainedCursor?: string
    tail: Promise<void>
    pending: boolean
    unknownSequence: boolean
    sharedRetained: boolean
  }
  const retained = createSseReplayBuffer<CentralFrame>({ isTerminal: isTerminalCentralFrame })
  const scopes = new Map<string, Scope>()
  const tombstones = new Map<string, { sequence: number; retainedCursor?: string }>()
  const subscriptionKey = (subscription: GlobalEventSubscription) => subscription.identity.mode === "unmanaged-local"
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
  const terminate = (scope: Scope, connection: Connection) => {
    scope.connections.delete(connection)
    connection.close()
  }
  const deliver = (
    scope: Scope,
    frame: CentralFrame,
    decisions: Array<{ connection: Connection; visible: boolean }>,
  ) => {
    const sessionId = globalEventSessionId(frame)
    let visible = false
    for (const decision of decisions) {
      if (!scope.connections.has(decision.connection)) continue
      if (!decision.visible) {
        if (sessionId && decision.connection.authorizedSessions.has(sessionId)) {
          terminate(scope, decision.connection)
        }
        continue
      }
      visible = true
      if (sessionId) decision.connection.authorizedSessions.add(sessionId)
      void Promise.resolve(decision.connection.push(frame)).catch(() => undefined)
    }
    if (visible && !scope.sharedRetained) {
      scope.replay.push(frame)
      scope.retainedCursor = retained.idFor(frame) ?? scope.retainedCursor
    }
    evict(scope)
  }
  const evaluate = (scope: Scope, frame: CentralFrame) => {
    const pending = [...scope.connections].map((connection) => {
      try {
        return { connection, visible: connection.subscription.visible(frame) }
      } catch {
        return { connection, visible: false as const }
      }
    })
    if (!pending.some((item) => item.visible instanceof Promise)) {
      deliver(scope, frame, pending as Array<{ connection: Connection; visible: boolean }>)
      return
    }
    return Promise.all(pending.map(async (item) => ({
      connection: item.connection,
      visible: await Promise.resolve(item.visible).catch(() => false),
    }))).then((decisions) => deliver(scope, frame, decisions))
  }
  const enqueue = (scope: Scope, frame: CentralFrame) => {
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
  const scopeFor = (subscription: GlobalEventSubscription) => {
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
        : createSseReplayBuffer<CentralFrame>({
            isTerminal: isTerminalCentralFrame,
            ...(tombstone ? { initialSequence: tombstone.sequence } : {}),
          }),
      connections: new Set(),
      reservations: 0,
      ...(tombstone?.retainedCursor ? { retainedCursor: tombstone.retainedCursor } : {}),
      tail: Promise.resolve(),
      pending: false,
      unknownSequence: !sharedRetained && !tombstone && retained.lastId() !== undefined,
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
  buses.globalBus.subscribe((event) => {
    frames.publish(normalizeGlobalEvent(event))
  })
  buses.claxedoBus.subscribe((event) => {
    frames.publish(event)
  })

  return async (c: Context) => {
    const subscription = await options.resolveSubscription?.(c) ?? {
      identity: { mode: "unmanaged-local" as const, connectionId: randomUUID() },
      visible: () => true,
    }
    const retainedCursor = retained.lastId()
    const scope = scopeFor(subscription)
    scope.reservations += 1
    await scope.tail
    return streamSSE(c, async (stream) => {
    // `attachSseFanout` recognises its heartbeat by object identity (that is how
    // it knows to shed heartbeats first when a pending queue overflows), so the
    // sentinel must be one stable object. The WIRE shape stays the legacy
    // `server.connected` envelope — claxedo-app's global-event projector treats
    // it as a "refresh the project catalog" nudge, so changing it would change
    // behaviour well beyond replay.
    const heartbeat = { type: "heartbeat" } as const
    const cursor = c.req.header("last-event-id") ?? scope.replay.lastId() ?? "0"
    const replay = scope.unknownSequence && Number(c.req.header("last-event-id") ?? "0") > 0
      ? { ...scope.replay, hasGap: () => true }
      : scope.replay

    await stream
      .writeSSE({ id: cursor, data: JSON.stringify(connectedFrame()) })
      .catch(() => {})

    const cleanup = attachSseFanout<CentralFrame>({
      subscribe: (listener) => {
        const close = () => stream.abort()
        const connection = { subscription, push: listener, close, authorizedSessions: new Set<string>() }
        scope.connections.add(connection)
        scope.reservations -= 1
        for (const retainedFrame of retained.replayAfter(retainedCursor)) enqueue(scope, retainedFrame.payload)
        return () => {
          scope.connections.delete(connection)
          evict(scope)
        }
      },
      write: async (frame, meta) => {
        const content = "type" in frame || "directory" in frame ? frame as CentralFrame : undefined
        if (content && !await Promise.resolve(subscription.visible(content)).catch(() => false)) {
          const sessionId = globalEventSessionId(content)
          if (sessionId && [...scope.connections].some((connection) =>
            connection.subscription === subscription && connection.authorizedSessions.has(sessionId))) {
            for (const connection of [...scope.connections]) {
              if (connection.subscription === subscription) terminate(scope, connection)
            }
          }
          return
        }
        const sessionId = content && globalEventSessionId(content)
        if (sessionId) {
          for (const connection of scope.connections) {
            if (connection.subscription === subscription) connection.authorizedSessions.add(sessionId)
          }
        }
        return stream.writeSSE({
          ...(meta?.id ? { id: meta.id } : {}),
          data: JSON.stringify(frame === heartbeat ? connectedFrame() : frame),
        })
      },
      heartbeat,
      heartbeatMs: 5_000,
      lastEventId: cursor,
      replay,
      replayLive: false,
      replayGap: ({ lastEventId, throughId }) => ({
        type: "stream.replay-gap",
        code: "global.sse_replay_gap",
        message: "Central event replay cursor is no longer available; refetch session and project state.",
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
  })
  }
}

/**
 * The process-wide instance. Built at module load so the ring starts filling as
 * soon as the compat routes are importable — retention that only began at the
 * first connection would miss the boot-time burst it exists to preserve.
 */
const globalEventsHandler = createGlobalEventsHandler()

export function streamGlobalEvents(c: Context) {
  return globalEventsHandler(c)
}
