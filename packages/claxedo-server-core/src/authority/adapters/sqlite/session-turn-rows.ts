import type { SessionTurnGrant, SessionTurnGrantIntent, SessionTurnLease } from "@claxedo/server-core/platform/auth/session-turn-authority"
import type { SqliteAuthorityDb } from "./workspace-authority-store"

/** The lease a caller claims to hold, as the authority validated it. */
export type OwnedTurn = { sessionId: string; workspaceId: string; turnId: string; leaseId: string; fencingToken: number }

export type TurnLeaseRow = {
  session_id: string
  workspace_id: string
  turn_id: string
  lease_id: string
  fencing_token: number
  actor_id: string
  acquired_at: number
  expires_at: number
  released_at: number | null
}

export function turnLease(db: SqliteAuthorityDb, sessionId: string) {
  return db.prepare<unknown[], TurnLeaseRow>(`SELECT * FROM session_turn_leases WHERE session_id = ?`).get(sessionId)
}

export type TurnGrantRow = {
  grant_id: string
  session_id: string
  workspace_id: string
  org_id: string
  actor_id: string
  intent: SessionTurnGrantIntent
  subject_session_id: string | null
  turn_id: string | null
  turn_id_prefix: string | null
  issued_at: number
  expires_at: number
  redeemed_at: number | null
  redeemed_turn_id: string | null
  revoked_at: number | null
  revoke_reason: string | null
}

export function turnGrant(db: SqliteAuthorityDb, grantId: string) {
  return db.prepare<unknown[], TurnGrantRow>(`SELECT * FROM session_turn_grants WHERE grant_id = ?`).get(grantId)
}

export function publicTurnGrant(row: TurnGrantRow): SessionTurnGrant
export function publicTurnGrant(row: TurnGrantRow | undefined): SessionTurnGrant | undefined
export function publicTurnGrant(row: TurnGrantRow | undefined): SessionTurnGrant | undefined {
  if (!row) return undefined
  return {
    grantId: row.grant_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    intent: row.intent,
    ...(row.subject_session_id === null ? {} : { subjectSessionId: row.subject_session_id }),
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    ...(row.turn_id_prefix === null ? {} : { turnIdPrefix: row.turn_id_prefix }),
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    ...(row.redeemed_at === null ? {} : { redeemedAt: row.redeemed_at }),
    ...(row.redeemed_turn_id === null ? {} : { redeemedTurnId: row.redeemed_turn_id }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  }
}

export function publicTurnLease(row: TurnLeaseRow): SessionTurnLease {
  return {
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    turnId: row.turn_id,
    leaseId: row.lease_id,
    fencingToken: row.fencing_token,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  }
}

export function ownsTurn(row: TurnLeaseRow | undefined, value: OwnedTurn, actorId: string): row is TurnLeaseRow {
  return matchesTurn(row, value, actorId) && row.released_at === null
}

export function matchesTurn(row: TurnLeaseRow | undefined, value: OwnedTurn, actorId: string): row is TurnLeaseRow {
  return Boolean(
    row
      && row.workspace_id === value.workspaceId
      && row.turn_id === value.turnId
      && row.lease_id === value.leaseId
      && row.fencing_token === value.fencingToken
      && row.actor_id === actorId,
  )
}
