// Canonical `document.changed` doorbell envelope on the CENTRAL bus.
// Single source of truth for frontend
// consumers. The server's `bus.ts` keeps its own matching definition across the
// package boundary (claxedo-app does not depend on claxedo-server) — keep the
// two in sync.
//
// Published by the claxedo-server documents backend from its save path
// (`publishDocumentEvent`), delivered on the central events stream, consumed by
// `editor/document-index.tsx` to refresh the INDEX.
//
// STATUS: the `/documents/events` SSE and the editor's
// external-change controller are GONE. The index doorbell below is the only
// surviving client consumer. An open editor no longer live-refreshes on an
// external write — the next save surfaces a CAS conflict instead. That is the
// accepted tradeoff; do not rebuild live-refresh on this doorbell.
export type DocumentChangedEvent = {
  type: "document.changed"
  documentId: string
  /**
   * Scope fields — required to filter to the current project, since the shared
   * central stream carries every project's events (the legacy SSE got this
   * scoping from its per-connection subscription). Routing hints, NOT an
   * authorization boundary.
   */
  orgId: string
  projectId: string
  /** Absent when the change is not a content write (e.g. rename/archive). */
  version?: string
  ts: number
}
