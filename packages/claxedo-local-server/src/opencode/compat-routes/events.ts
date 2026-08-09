import { randomUUID } from "crypto"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import { attachSseFanout, createSseReplayBuffer } from "@claxedo/agent-sdk-runtime/sse"
import { claxedoBus, createBus, globalBus, type ClaxedoEvent, type GlobalEvent } from "@claxedo/server-core/platform/runtime/lib/bus"
import { isTerminalClaxedoEvent } from "@claxedo/server-core/platform/http/event-retention"

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
type CentralFrame = NormalizedGlobalEvent | ClaxedoEvent | GlobalStreamGapEvent

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
 * ## No per-identity filter — on purpose, and it is pre-existing
 *
 * Unlike `routes/events.ts`, this handler applies no `eventVisibleTo` scoping:
 * `eventVisibleTo` default-denies every compat envelope and every `pty.*` /
 * `agent.lifecycle` / `session.lifecycle` frame to a signed caller, which is the
 * entire content of this stream, so adding it would silently empty the route for
 * signed self-host deployments. Authorization is the route-level
 * `controlPlaneRouteAuth` gate in `routes/opencode-compat.ts` instead. The ring
 * therefore does NOT cross a visibility boundary the live path does not already
 * cross — but it does widen the window: a caller presenting a low
 * `Last-Event-ID` now receives retained frames from before it connected. That is
 * a timing widening on an already-unfiltered route, not a new boundary.
 */
export function createGlobalEventsHandler(buses: GlobalEventsBuses = { globalBus, claxedoBus }) {
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
  const replay = createSseReplayBuffer<CentralFrame>({ isTerminal: isTerminalCentralFrame })
  frames.subscribe((frame) => {
    replay.push(frame)
  })
  buses.globalBus.subscribe((event) => {
    frames.publish(normalizeGlobalEvent(event))
  })
  buses.claxedoBus.subscribe((event) => {
    frames.publish(event)
  })

  return (c: Context) => streamSSE(c, async (stream) => {
    // `attachSseFanout` recognises its heartbeat by object identity (that is how
    // it knows to shed heartbeats first when a pending queue overflows), so the
    // sentinel must be one stable object. The WIRE shape stays the legacy
    // `server.connected` envelope — claxedo-app's global-event projector treats
    // it as a "refresh the project catalog" nudge, so changing it would change
    // behaviour well beyond replay.
    const heartbeat = { type: "heartbeat" } as const
    const cursor = c.req.header("last-event-id") ?? replay.lastId() ?? "0"

    await stream
      .writeSSE({ id: cursor, data: JSON.stringify(connectedFrame()) })
      .catch(() => {})

    const cleanup = attachSseFanout<CentralFrame>({
      subscribe: frames.subscribe,
      write: (frame, meta) => stream.writeSSE({
        ...(meta?.id ? { id: meta.id } : {}),
        data: JSON.stringify(frame === heartbeat ? connectedFrame() : frame),
      }),
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

/**
 * The process-wide instance. Built at module load so the ring starts filling as
 * soon as the compat routes are importable — retention that only began at the
 * first connection would miss the boot-time burst it exists to preserve.
 */
const globalEventsHandler = createGlobalEventsHandler()

export function streamGlobalEvents(c: Context) {
  return globalEventsHandler(c)
}
