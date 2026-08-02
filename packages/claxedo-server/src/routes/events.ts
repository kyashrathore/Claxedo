import { streamSSE } from "hono/streaming"
import { attachSseFanout, createSseReplayBuffer, type SseReplayBuffer } from "@claxedo/agent-sdk-runtime/sse"
import { claxedoBus, type ClaxedoEvent } from "../lib/bus"
import type { Context } from "hono"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
  type SignedControlPlaneAuth,
} from "../authority/auth"
import { isLoopbackLocalRequest } from "./local-only-projection"

// The per-event visibility predicate lives in the Worker-safe `event-visibility`
// module so the hosted `LiveSyncRoom` Durable Object can share the exact same
// scoping. Re-exported here for back-compat (events.test.ts imports it).
export { eventVisibleTo } from "./event-visibility"
import { eventScopePrincipal, eventVisibleTo, type EventScopePrincipal } from "./event-visibility"
import { isTerminalClaxedoEvent } from "./event-retention"

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
  verifier?: ClerkVerifier
  allowLoopbackLocal?: boolean
  /**
   * Resolves the caller's AUTHORITY-INTERNAL org id (`authority.resolveOrgId`)
   * at connect time — the namespace `document.changed`/`provision` events are
   * stamped with, so signed subscribers can receive them. The Clerk org claim
   * is deliberately never used here (disjoint namespace). Absent (no authority
   * composed) → signed subscribers see subject-keyed events only, fail-closed.
   */
  resolveOrgId?: (auth: SignedControlPlaneAuth) => Promise<string>
  /** Injectable for tests; production always reads the process-global bus. */
  bus?: ClaxedoEventBus
}

// Loopback requests bypass bearer auth (single-user desktop mode); model them
// as unsigned-local so the visibility predicate passes everything through.
const LOOPBACK_PRINCIPAL: EventScopePrincipal = { mode: "unsigned-local" }

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
 * ## Buffer / visibility split
 *
 * The retention ring is created ONCE per handler and fed by ONE bus
 * subscription that exists for the process lifetime — not per connection. That
 * is forced by what the fix is for: the frames worth recovering are exactly the
 * ones published while NO connection was attached, so a buffer that only starts
 * filling at connect time would be empty precisely when it is needed. It also
 * makes the `id:` cursor a single global publish-order sequence, which is what
 * lets a client resume against a *different* connection object after a
 * reconnect.
 *
 * The consequence is that the ring holds EVERY identity's frames, while this
 * stream is per-identity filtered (`eventVisibleTo`) — the bus is
 * server-global, so without that filter any valid bearer would observe every
 * other tenant's events. So the split is: **buffer everything once, filter on
 * read.** The filter runs in `write`, which is the single choke point
 * `attachSseFanout` funnels BOTH replayed and live frames through; putting it
 * there (rather than wrapping `subscribe`, which only covers the live half)
 * makes it impossible for the replay path to drift from the live path and start
 * leaking across the signed-mode visibility boundary on reconnect.
 *
 * Two knock-on effects, both accepted deliberately:
 *  - A filtered frame consumes an id without being delivered, so a quiet
 *    identity's cursor lags the ring. Harmless: those frames would never be
 *    delivered on replay either, and the next visible frame jumps the cursor
 *    forward.
 *  - `hasGap` is therefore computed over the SHARED sequence, so a busy
 *    multi-tenant bus can age a quiet identity's cursor out of the window and
 *    produce a replay-gap notice even though none of that identity's own frames
 *    were lost. Over-reporting is the only safe direction — the buffer cannot
 *    know whether an already-evicted frame was visible to the caller, and
 *    under-reporting would silently drop a real one. The cost is a redundant
 *    client refetch.
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
  // (`provision`, `workgraph.changed`, `document.changed`, `worktree.*`). No
  // token-level deltas ride here; those are on the runtime event hub. 256
  // control frames is far more than the worst client gap (45s heartbeat
  // watchdog + 2s reconnect floor) can span.
  const replay = createSseReplayBuffer<StreamFrame>({ isTerminal: isTerminalStreamFrame })
  bus.subscribe((event) => {
    replay.push(event)
  })
  return async function handler(c: Context) {
    // Rubric S1: every claxedoBus subscriber must pass the same control-plane
    // auth gate as the other claxedo routes. Without this gate an anonymous
    // connection (even from another origin if CORS allows) would tap the
    // global event bus and observe every user's session/workspace activity
    // events. In local/unsigned-local mode the gate is a pass-through.
    // D9 NOTE: the global `unsignedLocalRequestGuard` at the app-composition
    // root is now the PRIMARY unsigned-local gate (non-loopback unsigned is
    // rejected before this handler runs); the loopback check below stays as
    // defense-in-depth for compositions that mount this handler directly.
    try {
      if (options.allowLoopbackLocal && isLoopbackLocalRequest(c.req.raw)) {
        return streamClaxedoEvents(c, LOOPBACK_PRINCIPAL, bus, replay)
      }
      const ctx = await controlPlaneAuthContext(c.req.raw, {
        ...(options.authConfig ? { config: options.authConfig } : {}),
        ...(options.verifier ? { verifier: options.verifier } : {}),
      })
      // Resolve the internal org id ONCE per connection (not per event/frame).
      // A resolution failure fails the connect — the client's reconnect loop
      // retries — rather than silently degrading to a principal whose org
      // events would strand until the next reconnect anyway.
      const orgId = ctx.mode === "signed" && options.resolveOrgId
        ? await options.resolveOrgId(ctx)
        : undefined
      return streamClaxedoEvents(c, eventScopePrincipal(ctx, orgId), bus, replay)
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
) {
  return streamSSE(c, async (stream) => {
    const heartbeat = { type: "heartbeat" } as const
    const cursor = c.req.header("last-event-id") ?? replay.lastId() ?? "0"

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

    const cleanup = attachSseFanout<StreamFrame>({
      subscribe: bus.subscribe,
      // Returned, not voided: `attachSseFanout` awaits each write in turn, which
      // is what keeps frames ordered and applies backpressure.
      write: (frame, meta) => visibleTo(frame)
        ? stream.writeSSE({
            ...(meta?.id ? { id: meta.id } : {}),
            data: JSON.stringify(frame),
          })
        : undefined,
      heartbeat,
      heartbeatMs: 30_000,
      lastEventId: cursor,
      replay,
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
      stream.onAbort(() => {
        cleanup()
        resolve()
      })
    })
  })
}
