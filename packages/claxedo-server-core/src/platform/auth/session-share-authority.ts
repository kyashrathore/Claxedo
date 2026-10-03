import type { SharedSession } from "@claxedo/account-contract"
import type { SignedControlPlaneAuth } from "./auth"
import type { SessionShareLevel } from "./session-share-level"

/**
 * Canonical recipient identity resolved by the authority before a session
 * share is revoked. Routes use this target for recipient doorbells, including
 * grant-id-only revokes whose request body carries no recipient selector.
 */
export type SessionShareFanoutTarget = {
  grantedToTokenIdentifier?: string
  grantedToSubject?: string
  grantedToUserId?: string
  grantedToOrgId?: string
  grantedToTeamId?: string
  grantedToTeamPublicId?: string
}

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
  teams: Array<{
    team_id: string
    name: string
    is_shared: boolean
  }>
}

export type SessionShareAuthority = {
  resolveSessionShareRecipients?: (auth: SignedControlPlaneAuth, input: {
    sessionId: string
    workspaceId: string
    target: SessionShareFanoutTarget
  }) => Promise<string[]>
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
      grantedToTokenIdentifier?: string
      grantedToSubject?: string
      grantedToUserId?: string
      grantedToOrgId?: string
      grantedToTeamId?: string
      grantedToTeamPublicId?: string
    },
  ) => Promise<SessionShareGrantResult>
  revokeSessionShare?: (
    auth: SignedControlPlaneAuth,
    args: {
      sessionId: string
      workspaceId: string
      grantId?: string
      grantedToTokenIdentifier?: string
      grantedToSubject?: string
      grantedToUserId?: string
      grantedToOrgId?: string
      grantedToTeamId?: string
      grantedToTeamPublicId?: string
    },
  ) => Promise<SessionShareRevokeResult>
  listSessionShares?: (
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string },
  ) => Promise<SessionPeopleContext>
  listSharedSessions?: (auth: SignedControlPlaneAuth) => Promise<SharedSession[]>
}
