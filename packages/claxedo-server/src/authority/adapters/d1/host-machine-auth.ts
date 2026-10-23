import type { D1Database } from "@cloudflare/workers-types"
import { hostEnrollmentScope, type MachineAuthAdapter } from "@claxedo/server-core/platform/auth/host-connect-contract"
import { d1ConstraintFailure } from "../../../platform/db/d1-constraint"
import type { EnrollmentRow } from "./host-enrollment-records"

/**
 * What `verifyMachineRequest` reads about a machine in D1: the enrollment by
 * id, with the owner's standing answered in the same read, and the single-use
 * nonce ledger.
 */
export function d1MachineAuth(database: D1Database): MachineAuthAdapter {
  return {
    lookupEnrollment: async (enrollmentId) => {
      const row = await database.prepare(`
        select enrollment.*, exists (
          select 1 from users owner
          join actors owner_actor on owner_actor.actor_id = enrollment.owner_actor_id
            and owner_actor.user_id = owner.user_id
          where owner.user_id = enrollment.owner_user_id
            and owner.state = 'active' and owner_actor.state = 'active'
        ) as owner_eligible
        from host_enrollments enrollment where enrollment.enrollment_id = ?
      `).bind(enrollmentId).first<EnrollmentRow & { owner_eligible: number }>()
      if (!row) return undefined
      return {
        enrollment_id: row.enrollment_id,
        host_id: row.host_id,
        owner_user_id: row.owner_user_id,
        owner_actor_id: row.owner_actor_id,
        public_key_json: row.public_key_json,
        key_version: row.key_version,
        serving_generation: row.serving_generation,
        revoked_at: row.revoked_at,
        revoked_reason: row.revoked_reason,
        paused_at: row.paused_at,
        approval_requested_at: row.approval_requested_at,
        scope: hostEnrollmentScope(row.scope_json, row.scope_revision),
        ownerEligible: row.owner_eligible === 1,
      }
    },
    consumeNonce: async (input) => {
      try {
        await database.prepare(`
          insert into host_request_nonces (enrollment_id, nonce, expires_at) values (?, ?, ?)
        `).bind(input.enrollmentId, input.nonce, input.expiresAt).run()
        return true
      } catch (error) {
        if (d1ConstraintFailure(error)?.kind === "unique") return false
        throw error
      }
    },
  }
}
