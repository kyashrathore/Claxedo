import type { ControlPlaneEvent } from "@claxedo/server-core/platform/runtime/lib/bus"

/**
 * Retention policy for `cp/events`, shared by the local daemon's handler and
 * the hosted `LiveSyncRoom` so the two never disagree about what a
 * reconnecting reader can recover.
 *
 * Every notice on this stream settles something nothing re-states — a
 * provision reaching ready or error, a worktree landing, a document doorbell
 * (the client only re-reads when nudged, so a lost one stalls live sync until
 * the next unrelated mutation), a share grant. `createSseReplayBuffer` keeps
 * these in its second, independent ring; a provision's intermediate steps are
 * the only frames it lets the main ring evict.
 */
export function isRetainedControlPlaneEvent(event: ControlPlaneEvent): boolean {
  switch (event.type) {
    case "worktree.ready":
    case "worktree.failed":
    case "document.changed":
    case "session.share.changed":
    case "session.inventory.changed":
      return true
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
