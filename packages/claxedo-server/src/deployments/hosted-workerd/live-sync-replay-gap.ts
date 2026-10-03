/**
 * Synthetic frame written in place of a replay when the requested cursor has
 * already fallen out of the room's retention window (or belongs to a sequence
 * this room no longer has — see `cursorAhead`). Deliberately the same shape and
 * `code` as `ControlPlaneStreamGapEvent` in the local daemon's `shell/events.ts`:
 * hosted and local serve the same route to the same claxedo-app bundle, so a
 * consumer that grows a handler must not have to learn two spellings. Declared
 * here rather than imported because that module pulls the process-local
 * `controlBus` and `hono/streaming`, neither of which may enter the Worker
 * bundle.
 */
export type LiveSyncStreamGapEvent = {
  type: "stream.replay-gap"
  code: "cp.sse_replay_gap"
  message: string
  severity: "warn"
  lastEventId?: string
  throughId?: string
}

export function replayGapEvent(lastEventId?: string, throughId?: string): LiveSyncStreamGapEvent {
  return {
    type: "stream.replay-gap",
    code: "cp.sse_replay_gap",
    message: "Control plane event replay cursor is no longer available; refetch project and workspace state.",
    severity: "warn",
    ...(lastEventId ? { lastEventId } : {}),
    ...(throughId ? { throughId } : {}),
  }
}

function numericId(id: string | undefined) {
  if (!id) return 0
  const parsed = Number.parseInt(id, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * True when the presented cursor is numerically ahead of everything this room
 * has ever assigned — proof that the sequence it came from is gone.
 *
 * Ids only ever increase within one room instance, so strictly-greater is
 * impossible in normal operation. It happens when the Durable Object was
 * evicted (its in-memory ring, and with it the counter, resets to zero) or when
 * the caller's room name changed (an org grant moves a client from
 * `owner:<subject>` to `org:<id>`, whose sequence is unrelated).
 *
 * `SseReplayBuffer` cannot detect this on its own: `hasGap` short-circuits to
 * false whenever `after >= through`, and `replayAfter` filters to the empty
 * set, so a stale-high cursor is served silence — the client keeps a cursor
 * that will never match again and never learns its incremental view is stale.
 * Silence is the one failure mode a replay contract must not have, so the room
 * converts it into the same explicit gap notice a genuine eviction produces.
 */
export function cursorAhead(cursor: string | undefined, throughId: string | undefined) {
  return numericId(cursor) > numericId(throughId)
}
