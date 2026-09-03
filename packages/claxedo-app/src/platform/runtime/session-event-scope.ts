/**
 * The single owner of "which session's event streams must be open, and are
 * they open yet".
 *
 * Two app-side lanes carry a session's live frames, and each is opened by its
 * own provider:
 *
 *  - `workspace-bus` — `app/integrations/claxedo-events.tsx` reading
 *    `/api/wr/events`. Carries `session.lifecycle`, `session.updated`,
 *    `agent.lifecycle` and the pty/process frames.
 *  - `runtime-events` — `app/providers/global-sdk/provider.tsx` reading
 *    `/api/wr/runtime-events?parentSessionId=…`. Carries the message parts and
 *    deltas of a turn.
 *
 * A relay-backed (cloud / user-hosted) runtime composes `sessionAuthority:
 * "managed-private"`, and `authorizeSessionEventScope` in workspace-runtime
 * answers an UNSCOPED workspace stream on such a runtime with
 * `400 session_event_scope_required`. Those streams are therefore opened for
 * exactly one session id, and something has to say which one. Deriving it from
 * the shell route alone means the stream can only exist once the route names a
 * real session — after a first turn's session has already been created — so
 * frames published in between are lost: `/api/wr/events` serves a cursor-less
 * connection nothing from its replay buffer, and `/api/wr/runtime-events`
 * withholds the turn's frames until it opens and then flushes them in one late
 * burst.
 *
 * So the scope is owned here instead, with two writers and one answer: the
 * composer publishes the session id it just created through
 * {@link holdSessionEventScope} before it dispatches that session's first
 * prompt, and the route's reader publishes the shell route's session through
 * {@link setSessionEventRouteScope} on every navigation. The route wins whenever
 * it names a session, because a navigation to another session is the user moving
 * on; the held id only bridges the draft route, where the route names no session
 * at all.
 *
 * Both lanes READ that answer — {@link sessionEventScopeId} is reactive, so a
 * navigation retargets both. That is what makes an ATTACH (reaching a running
 * session by its route rather than creating it in the composer) open the same
 * lanes a create does.
 *
 * The two providers cannot share one of their own closures for this: the events
 * provider mounts ABOVE the global-sdk provider (`app/entry/app.tsx`'s
 * `AuthenticatedProviders` wraps `RuntimeProviders`), so neither can read the
 * other. This is the same single-writer platform module the connection state
 * already uses (`stream-sync-status.ts`, `features/workspaces/data/workspace-connection.ts`).
 *
 * A LOCAL (loopback) workspace needs no bridging: its runtime is unmanaged, so
 * its `/api/wr/events` stream is workspace-wide and already carries every
 * session's frames. That lane reports itself open with NO session id, and a
 * lane open without a session id satisfies readiness for any session — which is
 * why local needs no branch of its own here or in the composer.
 */

import { createEffect, createMemo, createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"

export type SessionEventStreamLane = "workspace-bus" | "runtime-events"

type LaneState = {
  /** A provider is driving this lane, so readiness waits for it. */
  registered: boolean
  /**
   * The scope of the stream this lane currently has open: the session id for a
   * session-scoped stream, the empty string for a workspace-wide one that
   * carries every session. Absent while the lane has no open stream.
   */
  open?: string
}

type SessionEventScopeState = {
  /** The session the composer published; overridden by any route session id. */
  held?: string
  /** The shell route's own session identity, published by the route's reader. */
  route?: string
  lanes: Partial<Record<SessionEventStreamLane, LaneState>>
}

const [scopeState, setScopeState] = createStore<SessionEventScopeState>({ lanes: {} })

/**
 * The settled answer, so a reader is woken by a change of SESSION and never by
 * a change of writer.
 *
 * Both writers publish the same session in the ordinary create flow: the
 * composer holds the id it just created, and the route publishes that same id
 * once the navigation lands. Reading `route ?? held` directly tracks both store
 * fields, so the second write re-notifies with an answer that never changed —
 * and a reader that treats the notification as a retarget tears its stream down
 * and reopens it with no cursor. The workspace bus and the compat stream are
 * served their whole retained log for a cursor-less connection, so every frame
 * already applied arrived a second time (a finished turn's `session.idle`
 * replayed, playing the completion sound twice). Settling by value means an
 * unchanged answer wakes nobody.
 */
const scopeId = createRoot(() => createMemo(() => scopeState.route ?? scopeState.held))

/** A workspace-wide stream carries every session, so it satisfies any scope. */
const WORKSPACE_WIDE = ""

/**
 * Publishes the session whose scoped streams must be open. Called by the
 * composer with the id of the session it created, before that session's first
 * prompt is dispatched and before the route navigates to it.
 */
export function holdSessionEventScope(sessionId: string): void {
  setScopeState("held", sessionId.trim() || undefined)
}

/**
 * Publishes the shell route's own session identity (absent on a draft route).
 * Called by the route's reader on every navigation.
 */
export function setSessionEventRouteScope(routeSessionId?: string): void {
  setScopeState("route", routeSessionId?.trim() || undefined)
}

/**
 * The session the scoped streams must carry, read reactively — and woken only
 * when that session changes, whichever writer supplied it.
 *
 * The route is authoritative whenever it names a session: opening a different
 * session is the user moving on from the one the composer published. Both lanes
 * read THIS rather than deriving their own answer — the runtime-events lane used
 * to derive its session from the live-session the history fetch happened to
 * mark, so a session reached by navigation (an attach) opened no lane until a
 * fetch had already run, and its turn's deltas were only ever seen as a whole
 * completed turn on the next refetch.
 */
export function sessionEventScopeId(): string | undefined {
  return scopeId()
}

/** Declares that a provider drives this lane, so readiness waits for it. */
export function registerSessionEventStreamLane(lane: SessionEventStreamLane): () => void {
  setScopeState("lanes", lane, { registered: true })
  return () => setScopeState("lanes", produce((lanes) => {
    delete lanes[lane]
  }))
}

/**
 * Reports the lane's stream as open. `sessionId` is the session the stream is
 * scoped to; omit it for a workspace-wide stream, which carries every session.
 */
export function reportSessionEventStreamOpen(lane: SessionEventStreamLane, sessionId?: string): void {
  setScopeState("lanes", lane, "open", sessionId?.trim() || WORKSPACE_WIDE)
}

/** Reports the lane's stream as no longer open (connect failure, teardown, retarget). */
export function reportSessionEventStreamClosed(lane: SessionEventStreamLane): void {
  setScopeState("lanes", lane, "open", undefined)
}

/** True once every registered lane has a stream open that carries `sessionId`. */
export function sessionEventStreamsOpen(sessionId: string | undefined): boolean {
  for (const lane of Object.values(scopeState.lanes)) {
    if (!lane?.registered) continue
    if (lane.open === undefined) return false
    if (lane.open !== WORKSPACE_WIDE && lane.open !== sessionId) return false
  }
  return true
}

/**
 * Resolves once {@link sessionEventStreamsOpen} holds for `sessionId`.
 *
 * Deliberately unbounded: the caller owns the bound it is willing to hold a
 * user's prompt for, and passes `signal` so a caller that stopped waiting
 * disposes its subscription instead of watching a session that never opens.
 */
export function whenSessionEventStreamsOpen(
  sessionId: string | undefined,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (sessionEventStreamsOpen(sessionId) || options.signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    createRoot((dispose) => {
      const settle = () => {
        dispose()
        resolve()
      }
      options.signal?.addEventListener("abort", settle, { once: true })
      createEffect(() => {
        if (!sessionEventStreamsOpen(sessionId)) return
        options.signal?.removeEventListener("abort", settle)
        settle()
      })
    })
  })
}

/** Test seam: drops every lane registration, open report and published scope. */
export function resetSessionEventScope(): void {
  setScopeState({ held: undefined, route: undefined, lanes: {} })
}
