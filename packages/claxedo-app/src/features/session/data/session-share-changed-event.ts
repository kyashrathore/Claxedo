// Canonical `session.share.changed` doorbell envelope on the CENTRAL bus.
// Single source of truth for frontend consumers. The server's `bus.ts` keeps
// its own matching definition across the package boundary (claxedo-app does
// not depend on claxedo-server) — keep the two in sync.
//
// Published after session share grant/revoke on the control plane, delivered
// on `/api/claxedo/events`, consumed by session event-ingress to invalidate
// rail session-list + inventory queries. Doorbell only — list APIs remain
// authoritative for which sessions appear.
export type SessionShareChangedEvent = {
  type: "session.share.changed"
  phase: "granted" | "revoked"
  /** Recipient Clerk subject — server scopes delivery to this subject. */
  ownerUserId: string
  sessionId: string
  workspaceId: string
  orgId?: string
  ts: number
}
