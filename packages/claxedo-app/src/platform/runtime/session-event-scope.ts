/**
 * The single owner of "which session's live frames must be streaming, and are
 * they yet".
 *
 * A session's live frames — its parts, deltas, tool state, lifecycle — ride
 * its workspace runtime's `wr/events`, opened by `ClaxedoEventsProvider`
 * (`app/integrations/claxedo-events.tsx`) once per open workspace. The
 * workspace's owner reads it unscoped and sees every session; a share grantee
 * is refused at workspace level and re-opens it for one session, so the
 * stream then carries exactly one session and something has to say which.
 *
 * Deriving that session from the shell route alone means the stream can only
 * exist once the route names a real session — after a first turn's session
 * has already been created — so frames published in between are lost: a
 * cursor-less connection is served nothing from the replay ring. So the scope
 * is owned here instead, with two writers and one answer: the composer
 * publishes the session id it just created through
 * {@link holdSessionEventScope} before it dispatches that session's first
 * prompt, and the route's reader publishes the shell route's session through
 * {@link setSessionEventRouteScope} on every navigation. The route wins
 * whenever it names a session, because a navigation to another session is
 * the user moving on; the held id only bridges the draft route, where the
 * route names no session at all.
 *
 * The reader reads that answer — {@link sessionEventScopeId} is reactive, so
 * a navigation retargets the scoped stream — and reports each workspace's
 * stream open or closed here, keyed by stream, with the session it is scoped
 * to. The composer awaits {@link whenSessionEventStreamsOpen} before its
 * first prompt so the turn's frames arrive live rather than as a late burst.
 * The composer cannot share the reader's closures for this: it mounts
 * underneath. This is the same single-writer platform module the connection
 * state already uses (`stream-sync-status.ts`,
 * `features/workspaces/data/workspace-connection.ts`).
 *
 * A stream open with NO session id is workspace-wide and satisfies readiness
 * for any session — which is why a local workspace, whose runtime is
 * unmanaged, needs no branch of its own here or in the composer.
 */

import { createEffect, createMemo, createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"

/** One workspace runtime's stream, keyed the way `stream-sync-status` keys it. */
export type SessionEventStreamLane = `wr:${string}`

type LaneState = {
  /** The reader is driving this stream, so readiness waits for it. */
  registered: boolean
  /**
   * The scope of the stream currently open: the session id for a
   * session-scoped stream, the empty string for a workspace-wide one that
   * carries every session. Absent while the stream is not open.
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
 * and reopens it with no cursor. A reopened session-scoped stream re-reads
 * from its retained ring, so every frame already applied arrived a second
 * time (a finished turn's `session.idle` replayed, playing the completion
 * sound twice). Settling by value means an unchanged answer wakes nobody.
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
 * The session a scoped stream must carry, read reactively — and woken only
 * when that session changes, whichever writer supplied it. The route is
 * authoritative whenever it names a session: opening a different session is
 * the user moving on from the one the composer published.
 */
export function sessionEventScopeId(): string | undefined {
  return scopeId()
}

/** Declares that the reader drives this stream, so readiness waits for it. */
export function registerSessionEventStreamLane(lane: SessionEventStreamLane): () => void {
  setScopeState("lanes", lane, { registered: true })
  return () => setScopeState("lanes", produce((lanes) => {
    delete lanes[lane]
  }))
}

/**
 * Reports the stream as open. `sessionId` is the session the stream is scoped
 * to; omit it for a workspace-wide stream, which carries every session.
 */
export function reportSessionEventStreamOpen(lane: SessionEventStreamLane, sessionId?: string): void {
  setScopeState("lanes", lane, "open", sessionId?.trim() || WORKSPACE_WIDE)
}

/** Reports the stream as no longer open (connect failure, teardown, retarget). */
export function reportSessionEventStreamClosed(lane: SessionEventStreamLane): void {
  setScopeState("lanes", lane, "open", undefined)
}

/** True once every registered stream is open and carries `sessionId`. */
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

/** Test seam: drops every stream registration, open report and published scope. */
export function resetSessionEventScope(): void {
  setScopeState({ held: undefined, route: undefined, lanes: {} })
}
