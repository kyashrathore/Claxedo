import type { SignedControlPlaneAuth } from "./auth"
import type { SessionPageQuery } from "./private-session-authority"

/** Canonical identity contract returned by authority-backed session inventory. */
export type AuthoritySessionInventoryRow = {
  session_id: string
  workspace_id?: string
  [field: string]: unknown
}

/** Authorized inventory filtering and counts happen before the page window. */
export type SessionInventoryAuthority = {
  listSessions: (auth: SignedControlPlaneAuth, args: { workspaceId: string }) => Promise<AuthoritySessionInventoryRow[]>
  listSessionPage: (auth: SignedControlPlaneAuth, args: SessionPageQuery) => Promise<AuthoritySessionInventoryRow[]>
  countSessions?: (auth: SignedControlPlaneAuth, query: SessionPageQuery) => Promise<number>
}
