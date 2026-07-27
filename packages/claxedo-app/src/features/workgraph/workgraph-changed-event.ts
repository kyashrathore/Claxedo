// Canonical `workgraph.changed` doorbell envelope.
// Single source of truth for frontend consumers. The server's `bus.ts` keeps its
// own matching definition across the package boundary (claxedo-app does not
// depend on claxedo-server) — keep the two in sync.
//
// Published by the claxedo-server WorkGraph host post-commit (coalesced ~100ms),
// delivered on the central events stream, consumed here by `features/workgraph`
// to debounce-reload the snapshot + attention. Replaces the deleted
// `GET /api/workgraph/changes` long-poll.
//
// Doorbell only — no change payload. The client re-reads state; the ordered
// `wg_v2_changes` log stays server-side.
export type WorkgraphChangedEvent = {
  type: "workgraph.changed"
  /**
   * Client-side routing hint (WorkGraph is owner-scoped) — NOT an authorization
   * boundary: the central stream is unfiltered, and the reload this triggers is
   * authorized per-request by the snapshot endpoint.
   */
  ownerUserId: string
  ts: number
}
