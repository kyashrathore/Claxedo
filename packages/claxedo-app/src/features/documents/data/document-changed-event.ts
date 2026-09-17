// The `document.changed` doorbell as it arrives on `cp/events`: the one
// definition frontend consumers read. The server's `bus.ts`
// (`claxedo-server-core/src/platform/runtime/lib/bus.ts`) keeps its own
// matching definition across the package boundary (claxedo-app does not
// depend on it) — keep the two in sync.
//
// Published by the documents backend from its save path
// (`publishDocumentEvent`); consumed by `editor/document-index.tsx` to
// refresh the INDEX. It is a doorbell, not a change envelope: an open editor
// does not live-refresh on an external write — the next save surfaces a CAS
// conflict instead. That is the accepted tradeoff; do not rebuild
// live-refresh on this doorbell.
export type DocumentChangedEvent = {
  type: "document.changed"
  documentId: string
  /**
   * Scope fields — required to filter to the current project, since one
   * `cp/events` connection carries every project's doorbells the subscriber
   * may see. Routing hints, NOT an authorization boundary.
   */
  orgId: string
  projectId: string
  /** Absent when the change is not a content write (e.g. rename/archive). */
  version?: string
  ts: number
}
