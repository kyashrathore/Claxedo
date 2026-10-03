import type { PrivateSessionRegistrationState } from "@claxedo/server-core/platform/auth/private-session-authority"
import type { SessionTurnGrant, SessionTurnGrantIntent, SessionTurnLease } from "@claxedo/server-core/platform/auth/session-turn-authority"

export type ActorRow = {
  actor_id: string
  actor_kind: "human" | "agent"
  actor_state: "active" | "suspended" | "revoked"
  user_id: string | null
  user_state: "active" | "suspended" | "deleted" | null
}

export type WorkspaceAccessRow = {
  workspace_id: string
  org_id: string
  project_id: string
  backing: "cloud-vm" | "local-worktree"
}

export type SessionRow = {
  session_id: string
  operation_id: string
  workspace_id: string
  org_id: string
  project_id: string
  creator_actor_id: string
  lifecycle_generation: number
  title: string | null
  created_at: number
  updated_at: number
  last_human_turn_at: number | null
  deleted_at: number | null
  max_event_ordinal: number
  snapshot_generation: number
  snapshot_hash: string | null
  session_host_root: string | null
}

export type RegistrationRow = {
  operation_id: string
  session_id: string
  workspace_id: string
  org_id: string
  project_id: string
  creator_actor_id: string
  operation_kind: "create" | "fork"
  parent_session_id: string | null
  requested_title: string | null
  session_host_root: string | null
  state: PrivateSessionRegistrationState
  state_reason: string | null
  created_at: number
  updated_at: number
}

export type SessionShareRow = {
  grant_id: string
  session_id: string
  workspace_id: string
  org_id: string
  project_id: string
  target_user_id: string
  granted_by_actor_id: string
  granted_at: number
  revoked_at: number | null
  level: string
}

export type SessionShareTarget =
  | { kind: "user"; id: string }
  | { kind: "org"; id: string }
  | { kind: "team"; id: string }

export type TurnLeaseRow = {
  session_id: string
  workspace_id: string
  org_id: string
  project_id: string
  turn_id: string
  lease_id: string
  fencing_token: number
  actor_id: string
  acquired_at: number
  expires_at: number
  released_at: number | null
}

export type TurnGrantRow = {
  grant_id: string
  session_id: string
  workspace_id: string
  org_id: string
  project_id: string
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

export function registrationResult(row: RegistrationRow, changed: boolean) {
  return {
    changed,
    operationId: row.operation_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    state: row.state,
    ...(row.session_host_root === null ? {} : { sessionHostRoot: row.session_host_root }),
  }
}

export function sessionJson(row: SessionRow) {
  return {
    session_id: row.session_id,
    project_id: row.project_id,
    ...(row.title === null ? {} : { title: row.title }),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.last_human_turn_at === null ? {} : { last_human_turn_at: row.last_human_turn_at }),
    ...(row.session_host_root === null ? {} : { session_host_root: row.session_host_root }),
  }
}

export function turnGrantJson(row: TurnGrantRow): SessionTurnGrant
export function turnGrantJson(row: TurnGrantRow | null): SessionTurnGrant | undefined
export function turnGrantJson(row: TurnGrantRow | null): SessionTurnGrant | undefined {
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

export function turnLeaseJson(row: TurnLeaseRow): SessionTurnLease {
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
