import type { ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"

/**
 * Retention policy for `cp/events`, shared by the local daemon's handler and
 * the hosted `LiveSyncRoom` so the two never disagree about what a
 * reconnecting reader can recover.
 *
 * A doorbell settles something nothing re-states — a provision reaching
 * ready or error, a worktree landing, a document doorbell (the client only
 * re-reads when nudged, so a lost one stalls live sync until the next
 * unrelated mutation), a share grant. `createSseReplayBuffer` keeps these in
 * its second, independent ring; a provision's intermediate steps, quota
 * doorbells, session status notices and reader notices are the frames it lets
 * the main ring evict, and an evicted one surfaces as a replay gap.
 */
export function isRetainedControlPlaneEvent(event: ControlPlaneEvent): boolean {
  switch (event.type) {
    case "worktree.ready":
    case "worktree.failed":
    case "document.changed":
    case "session.share.changed":
    case "session.inventory.changed":
    case "plugins.changed":
      return true
    case "session.status.changed":
      // Rung on every turn start, end and wait of every session a reader
      // follows; in the terminal ring it would evict the doorbells above.
      return false
    case "usage.quota.changed":
      // Rung several times per dashboard open; retained, it would push the
      // doorbells above out of the ring. The view re-reads on a gap anyway.
      return false
    case "provision":
      return event.step === "ready" || event.step === "error"
    default:
      return false
  }
}

/**
 * A status notice states the whole status of one session for one reader, and
 * a reader notice all of one reader's marks on it, so a later one of the same
 * kind makes an earlier one moot: a replay sends the latest of each.
 */
export function supersededControlPlaneEventKey(event: ControlPlaneEvent): string | undefined {
  if (event.type !== "session.status.changed" && event.type !== "session.reader.changed") return undefined
  return `${event.type}\u0000${event.ownerUserId}\u0000${event.sessionId}`
}
