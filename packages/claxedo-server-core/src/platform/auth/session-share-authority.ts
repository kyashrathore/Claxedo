import type { SharedSession } from "@claxedo/account-contract"
import type { SignedControlPlaneAuth } from "./auth"
import type { SessionShareLevel } from "./session-share-level"

/**
 * The one person a session share names, by exactly one of these. A share
 * names a person and nothing else: no team or organization is a recipient.
 */
export type SessionShareRecipient = {
  grantedToTokenIdentifier?: string
  grantedToSubject?: string
  grantedToUserId?: string
}

/**
 * Canonical recipient identity resolved by the authority before a session
 * share is revoked. Routes use this target for recipient doorbells, including
 * grant-id-only revokes whose request body carries no recipient selector.
 */
export type SessionShareFanoutTarget = SessionShareRecipient

export type SessionShareRevokeResult = {
  revoked: boolean
  runtime_tokens_revoked?: number
  revokedTargets: SessionShareFanoutTarget[]
}

export type SessionShareGrantResult = {
  grant_id: string
  level: SessionShareLevel
}

export type SessionPeopleContext = {
  can_manage_shares: boolean
  grants: Array<Record<string, unknown>>
}

export type SessionShareAuthority = {
  /**
   * Creates the grant, or moves an existing one to `level`. One active grant
   * per (session, target) is the store's unique index, so a second grant at a
   * different level is the downgrade/upgrade control rather than a conflict.
   */
  grantSessionShare?: (
    auth: SignedControlPlaneAuth,
    args: {
      sessionId: string
      workspaceId: string
      level?: SessionShareLevel
    } & SessionShareRecipient,
  ) => Promise<SessionShareGrantResult>
  revokeSessionShare?: (
    auth: SignedControlPlaneAuth,
    args: {
      sessionId: string
      workspaceId: string
      grantId?: string
    } & SessionShareRecipient,
  ) => Promise<SessionShareRevokeResult>
  listSessionShares?: (
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string },
  ) => Promise<SessionPeopleContext>
  listSharedSessions?: (auth: SignedControlPlaneAuth) => Promise<SharedSession[]>
}
