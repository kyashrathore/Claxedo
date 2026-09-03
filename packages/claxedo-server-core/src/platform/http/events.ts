import { streamSSE } from "hono/streaming"
import { attachSseFanout, createSseReplayBuffer, type SseReplayBuffer } from "@claxedo/agent-sdk-runtime/sse"
import { claxedoBus, type ClaxedoEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import type { Context } from "hono"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ControlPlaneTokenVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "@claxedo/server-core/platform/auth/auth"
import { isLoopbackLocalRequest } from "@claxedo/server-core/platform/http/peer-address"

// The per-event visibility predicate lives in the Worker-safe `event-visibility`
// module so the hosted `LiveSyncRoom` Durable Object can share the exact same
// scoping. Re-exported here for back-compat (events.test.ts imports it).
export { eventVisibleTo } from "./event-visibility"
import { eventScopePrincipal, eventVisibleTo, type EventScopePrincipal } from "./event-visibility"
import { isTerminalClaxedoEvent } from "@claxedo/server-core/platform/http/event-retention"

/**
 * Synthetic frame written in place of a replay when the requested cursor has
 * already fallen out of the retention window. Mirrors
 * `WorkspaceRuntimeStreamGapEvent` in
 * `packages/workspace-runtime/src/routes/runtime-events.ts`: deliberately NOT a
 * member of {@link ClaxedoEvent} (nothing publishes it onto the bus, it only
 * ever exists per-connection), and consumers that do not know the type ignore
 * it — claxedo-app's emitter dispatches by `type` and no-ops on an unregistered
 * one. Consumers that DO know it should refetch the state this stream feeds
 * rather than trusting their incremental view.
 */
export type ClaxedoStreamGapEvent = {
  type: "stream.replay-gap"
  code: "claxedo.sse_replay_gap"
  message: string
  severity: "warn"
  lastEventId?: string
  throughId?: string
}

type StreamFrame = ClaxedoEvent | ClaxedoStreamGapEvent

/** Frame shapes `attachSseFanout` can hand to `write` for this stream. */
type WriteFrame = StreamFrame | { payload: { type: "server.heartbeat"; properties: {} } }

/** The gap frame is per-connection and never worth a slot in the terminal ring. */
function isTerminalStreamFrame(frame: StreamFrame) {
  return frame.type === "stream.replay-gap" ? false : isTerminalClaxedoEvent(frame)
}

type ClaxedoEventBus = Pick<typeof claxedoBus, "subscribe">

export type EventsHandlerOptions = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  allowLoopbackLocal?: boolean
  /**
   * Resolves the caller's AUTHORITY-INTERNAL org id (`authority.resolveOrgId`)
   * at connect time — the namespace `document.changed`/`provision` events are
   * stamped with, so signed subscribers can receive them. The issuer org claim
   * is deliberately never used here (disjoint namespace). Absent (no authority
   * composed) → signed subscribers see subject-keyed events only, fail-closed.
   */
  resolveOrgId?: (auth: SignedControlPlaneAuth) => Promise<string>
  /** Injectable for tests; production always reads the process-global bus. */
  bus?: ClaxedoEventBus
}

// Unsigned loopback requests bypass bearer auth (single-user desktop mode);
// bearer-bearing loopback requests are still signed clients and must retain
// tenant filtering.
const LOOPBACK_PRINCIPAL: EventScopePrincipal = { mode: "unsigned-local" }

function samePrincipal(left: EventScopePrincipal, right: EventScopePrincipal) {
  if (left.mode !== right.mode) return false
  if (left.mode === "unsigned-local" || right.mode === "unsigned-local") return true
  return left.subject === right.subject && left.orgId === right.orgId
}

/**
 * `/api/claxedo/events` — the central control-plane bus stream.
 *
 * Resumable by SSE `Last-Event-ID`, mirroring the workspace-scoped
 * `runtimeBusEventsHandler`
 * (`packages/workspace-runtime/src/routes/runtime-events.ts`). Before this the
 * handler was subscribe-on-connect only: every frame published while a consumer
 * sat in its reconnect gap (claxedo-app's 2s reconnect floor, its 45s heartbeat
 * watchdog, the 2s session-switch quiet window) was gone for good, and only the
 * frame types with an independent REST reconciliation path recovered.
 *
 * ## Retention / identity split
 *
 * The source retention ring is created ONCE per handler and fed by ONE bus
 * subscription that exists for the process lifetime — not per connection. That
 * is forced by what the fix is for: the frames worth recovering are exactly the
 * ones published while NO connection was attached, so a buffer that only starts
 * filling at connect time would be empty precisely when it is needed. It also
 * lets a newly seen principal recover events published before its first
 * connection.
 *
 * The source ring holds every identity's frames, while each verified principal
 * gets a stable replay ring containing only frames that clear
 * `eventVisibleTo`. Cursor ids are minted by that filtered ring, so another
 * tenant's traffic neither creates holes nor ages a quiet principal's cursor
 * out of retention. Live and replay writes still re-run the same predicate at
 * the final delivery choke point, preserving the fail-closed boundary if a
 * frame or principal shape changes.
 *
 * ## Cursor-less connections are served NOTHING from the buffer
 *
 * They resume from `replay.lastId()`, i.e. "everything from now on". claxedo-app
 * reads this stream with `app/integrations/claxedo-events.tsx`, which unwraps
 * frames and applies them to the shell caches, so a full re-read on every fresh
 * connection would re-apply consumed frames (the `permission.asked` /
 * `question.asked` class, which arrive here as compat envelopes on the sibling
 * `/api/wr/events`) and resurrect docks the user already dismissed. Re-applying
 * is safe for the pure state frames on this bus and NOT safe for the
 * accumulating ones, so the handler never creates the duplicate rather than
 * sorting frames into safe and unsafe buckets.
 *
 * The connection opens with a heartbeat carrying the cursor it resumes from,
 * written BEFORE the fanout attaches. Without it the buffer would be dead
 * weight for exactly the gap that matters most: a reader only learns a cursor by
 * receiving a frame, so a reader that drops before its first frame reconnects
 * cursor-less and the fix would not apply to it. Writing it first means it can
 * never interleave ahead of replayed frames and walk a reader's cursor forward
 * past frames it has not seen. Periodic heartbeats intentionally carry NO id, so
 * a frame shed from a saturated pending queue is redelivered on the next
 * reconnect instead of being skipped over.
 */
export function eventsHandler(options: EventsHandlerOptions = {}) {
  const bus = options.bus ?? claxedoBus
  // Retention matches the workspace fix (256 frames + a 64-frame terminal ring)
  // because it is literally the same bus — `claxedoBus` is `workspaceRuntimeBus`
  // — carrying control frames only, plus the handful of control-plane events
  // (`provision`, `document.changed`, `worktree.*`). No
  // token-level deltas ride here; those are on the runtime event hub. 256
  // control frames is far more than the worst client gap (45s heartbeat
  // watchdog + 2s reconnect floor) can span.
  const retained = createSseReplayBuffer<StreamFrame>({ isTerminal: isTerminalStreamFrame })
  const scopes = new Map<string, {
    key: string
    principal: EventScopePrincipal
    replay: SseReplayBuffer<StreamFrame>
    connections: number
    sharedRetained: boolean
    unknownSequence: boolean
  }>()
  const tombstones = new Map<string, { sequence: number; retainedCursor?: string }>()
  const scopeFor = (principal: EventScopePrincipal) => {
    const key = principal.mode === "unsigned-local"
      ? "unsigned-local"
      : JSON.stringify([principal.subject, principal.orgId ?? null])
    const existing = scopes.get(key)
    if (existing) return existing
    const tombstone = tombstones.get(key)
    tombstones.delete(key)
    const sharedRetained = principal.mode === "unsigned-local"
    const replay = sharedRetained
      ? retained
      : createSseReplayBuffer<StreamFrame>({
          isTerminal: isTerminalStreamFrame,
          ...(tombstone ? { initialSequence: tombstone.sequence } : {}),
        })
    if (!sharedRetained) {
      for (const event of retained.replayAfter(tombstone?.retainedCursor)) {
        if (eventVisibleTo(principal, event.payload as ClaxedoEvent)) replay.push(event.payload)
      }
    }
    const scope = {
      key,
      principal,
      replay,
      connections: 0,
      sharedRetained,
      unknownSequence: !sharedRetained && !tombstone && retained.lastId() !== undefined,
    }
    scopes.set(key, scope)
    return scope
  }
  const release = (scope: ReturnType<typeof scopeFor>) => {
    scope.connections -= 1
    if (scope.connections > 0 || scopes.get(scope.key) !== scope) return
    if (!scope.sharedRetained) {
      const retainedCursor = retained.lastId()
      tombstones.delete(scope.key)
      tombstones.set(scope.key, {
        sequence: Number(scope.replay.lastId() ?? "0"),
        ...(retainedCursor ? { retainedCursor } : {}),
      })
      while (tombstones.size > 256) tombstones.delete(tombstones.keys().next().value!)
    }
    scopes.delete(scope.key)
  }
  bus.subscribe((event) => {
    retained.push(event)
    for (const scope of scopes.values()) {
      if (!scope.sharedRetained && eventVisibleTo(scope.principal, event)) scope.replay.push(event)
    }
  })
  return async function handler(c: Context) {
    // Every claxedoBus subscriber must pass the same control-plane
    // auth gate as the other claxedo routes. Without this gate an anonymous
    // connection (even from another origin if CORS allows) would tap the
    // global event bus and observe every user's session/workspace activity
    // events. In local/unsigned-local mode the gate is a pass-through.
    // NOTE: the global `unsignedLocalRequestGuard` at the app-composition
    // root is now the PRIMARY unsigned-local gate (non-loopback unsigned is
    // rejected before this handler runs); the loopback check below stays as
    // defense-in-depth for compositions that mount this handler directly.
    try {
      if (
        options.allowLoopbackLocal &&
        isLoopbackLocalRequest(c.req.raw) &&
        !c.req.header("authorization")
      ) {
        const scope = scopeFor(LOOPBACK_PRINCIPAL)
        scope.connections += 1
        return streamClaxedoEvents(c, LOOPBACK_PRINCIPAL, bus, scope.replay, () => release(scope), scope.unknownSequence)
      }
      const authenticate = () => controlPlaneAuthContext(c.req.raw, {
        ...(options.authConfig ? { config: options.authConfig } : {}),
        ...(options.verifier ? { verifier: options.verifier } : {}),
      })
      const ctx = await authenticate()
      const orgId = ctx.mode === "signed" && options.resolveOrgId
        ? await options.resolveOrgId(ctx)
        : undefined
      const principal = eventScopePrincipal(ctx, orgId)
      const scope = scopeFor(principal)
      scope.connections += 1
      return streamClaxedoEvents(
        c,
        principal,
        bus,
        scope.replay,
        () => release(scope),
        scope.unknownSequence,
        async () => {
          const current = await authenticate()
          const currentOrgId = current.mode === "signed" && options.resolveOrgId
            ? await options.resolveOrgId(current)
            : undefined
          return samePrincipal(principal, eventScopePrincipal(current, currentOrgId))
        },
      )
    } catch (err) {
      if (err instanceof ControlPlaneAuthError) {
        return c.json(controlPlaneAuthErrorBody(err), err.status)
      }
      throw err
    }
  }
}

function streamClaxedoEvents(
  c: Context,
  principal: EventScopePrincipal,
  bus: ClaxedoEventBus,
  replay: SseReplayBuffer<StreamFrame>,
  release: () => void,
  unknownSequence: boolean,
  stillAuthorized?: () => Promise<boolean>,
) {
  return streamSSE(c, async (stream) => {
    const heartbeat = { type: "heartbeat" } as const
    const cursor = c.req.header("last-event-id") ?? replay.lastId() ?? "0"
    const connectionReplay = unknownSequence && Number(c.req.header("last-event-id") ?? "0") > 0
      ? { ...replay, hasGap: () => true }
      : replay

    // The replay-gap notice and the connection's own heartbeats carry no tenant
    // data — only cursor ids — and the gap notice exists precisely to tell a
    // caller to refetch, so both bypass the identity filter. Everything else
    // (replayed or live, no distinction) must clear `eventVisibleTo`.
    const visibleTo = (frame: WriteFrame) => {
      if (frame === heartbeat) return true
      if (!("type" in frame)) return true
      if (frame.type === "stream.replay-gap") return true
      return eventVisibleTo(principal, frame)
    }

    await stream
      .writeSSE({ id: cursor, data: JSON.stringify(heartbeat) })
      .catch(() => {})

    let cleanup = () => {}
    let closed = false
    let finish: (() => void) | undefined
    const releaseOnce = () => {
      if (closed) return
      closed = true
      cleanup()
      release()
      finish?.()
    }
    const closeUnauthorized = async () => {
      releaseOnce()
      await stream.close()
    }

    cleanup = attachSseFanout<StreamFrame>({
      subscribe: bus.subscribe,
      // Returned, not voided: `attachSseFanout` awaits each write in turn, which
      // is what keeps frames ordered and applies backpressure.
      write: async (frame, meta) => {
        if (stillAuthorized) {
          const authorized = await stillAuthorized().catch(() => false)
          if (!authorized) {
            await closeUnauthorized()
            return
          }
        }
        if (!visibleTo(frame)) return
        await stream.writeSSE({
          ...(meta?.id ? { id: meta.id } : {}),
          data: JSON.stringify(frame),
        })
      },
      heartbeat,
      heartbeatMs: 30_000,
      lastEventId: cursor,
      replay: connectionReplay,
      replayLive: false,
      replayGap: ({ lastEventId, throughId }) => ({
        type: "stream.replay-gap",
        code: "claxedo.sse_replay_gap",
        message: "Claxedo event replay cursor is no longer available; refetch control-plane state.",
        severity: "warn",
        ...(lastEventId ? { lastEventId } : {}),
        ...(throughId ? { throughId } : {}),
      }),
    })

    await new Promise<void>((resolve) => {
      finish = resolve
      if (closed) resolve()
      stream.onAbort(() => {
        releaseOnce()
        resolve()
      })
    })
  })
}
