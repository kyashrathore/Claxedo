import { createRequireText } from "@claxedo/helpers"
import type { D1Database } from "@cloudflare/workers-types"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import type { HostEnrollment } from "@claxedo/server-core/platform/auth/host-connect-contract"
import { D1HostAccessAuthorityError } from "./host-access-errors"

export type EnrollmentRow = {
  enrollment_id: string
  owner_user_id: string
  owner_actor_id: string
  host_id: string
  public_key_json: string
  display_name: string | null
  last_seen_at: number
  expires_at: number
  paused_at: number | null
  revoked_at: number | null
  last_signature_hash: string | null
  session_authority: string | null
  created_at: number
  updated_at: number
  key_version: number
  serving_generation: number
  generation_acquired_at: number | null
  enrolled_via: "account" | "invitation"
  scope_json: string | null
  scope_revision: number
  sealing_public_key_json: string | null
  provider_config_sealed: string | null
  provider_config_revision: number
  provider_config_acked_revision: number
  provider_config_updated_at: number | null
  provider_config_sealed_key_json: string | null
  provider_config_provider_ids: string | null
}

export type InvitationRow = {
  invitation_id: string
  owner_user_id: string
  owner_actor_id: string
  org_id: string
  secret_hash: string
  display_name: string | null
  scope_json: string
  expires_at: number
  redeemed_at: number | null
  redeemed_enrollment_id: string | null
  redeemed_host_id: string | null
  redeemed_public_key_fingerprint: string | null
  created_by_actor_id: string
  created_at: number
  revoked_at: number | null
}

/** The enrollment lease a new enrollment starts with and a beat renews when it names none. */
export const DEFAULT_TTL_MS = 60_000

/**
 * The machine caller's eligibility, evaluated inside every batch that mutates
 * on its behalf: the enrollment is live, the key the verifier read is still
 * the key on the row, and the owner is an active user with an active actor.
 * Written against `host_enrollments` unaliased, binding `enrollment_id` and
 * `key_version` in that order.
 */
export const MACHINE_ELIGIBLE_SQL = `enrollment_id = ? and key_version = ? and revoked_at is null and paused_at is null
        and exists (
          select 1 from users owner
          join actors owner_actor on owner_actor.actor_id = host_enrollments.owner_actor_id
            and owner_actor.user_id = owner.user_id
          where owner.user_id = host_enrollments.owner_user_id
            and owner.state = 'active' and owner_actor.state = 'active'
        )`

export const { requireText, optionalText } = createRequireText((message) => new D1HostAccessAuthorityError("invalid_input", message))

export function requireRevision(value: number, name: string, minimum: 0 | 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new D1HostAccessAuthorityError("invalid_input", `${name} must be an integer of at least ${minimum}`)
  }
  return value
}

export function enrollmentJson(row: EnrollmentRow): HostEnrollment {
  return {
    enrollment_id: row.enrollment_id,
    host_id: row.host_id,
    ...(row.display_name ? { display_name: row.display_name } : {}),
    expires_at: row.expires_at,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
  }
}

export function denied(message = "Workspace authority denied access") {
  return new ControlPlaneAuthError(403, "workspace_authorization_denied", message)
}

export async function enrollmentOf(database: D1Database, actorId: string, hostId: string) {
  return await database.prepare(`select * from host_enrollments where owner_actor_id = ? and host_id = ?`)
    .bind(actorId, hostId).first<EnrollmentRow>()
}

export async function enrollmentById(database: D1Database, enrollmentId: string) {
  return await database.prepare(`select * from host_enrollments where enrollment_id = ?`)
    .bind(enrollmentId).first<EnrollmentRow>()
}

/** The organization an invitation-enrolled machine is confined to. */
export async function invitationOrgOf(database: D1Database, enrollmentId: string) {
  const row = await database.prepare(`
    select org_id from host_invitations where redeemed_enrollment_id = ? limit 1
  `).bind(enrollmentId).first<{ org_id: string }>()
  return row?.org_id
}
