import type { D1Database } from "@cloudflare/workers-types"
import type { SandboxPassRecord, SandboxPassRegister } from "./sandbox-pass-register"

type PassRow = {
  jti: string
  audience: string
  user_id: string
  org_id: string
  project_id: string | null
  workspace_id: string
  session_id: string | null
  issued_at: number
  expires_at: number
}

function recordOf(row: PassRow): SandboxPassRecord {
  return {
    jti: row.jti,
    audience: row.audience,
    scope: {
      userId: row.user_id,
      orgId: row.org_id,
      workspaceId: row.workspace_id,
      ...(row.project_id ? { projectId: row.project_id } : {}),
      ...(row.session_id ? { sessionId: row.session_id } : {}),
    },
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
  }
}

/** The hosted register over the `sandbox_passes` table of `CONTROL_PLANE_DB`. */
export function createD1SandboxPassRegister(input: { database: D1Database; now?: () => number }): SandboxPassRegister {
  const now = input.now ?? Date.now
  return {
    async record(pass) {
      // Pruning rides on the mint rather than on a schedule this Worker does
      // not have; a pass lives at most an hour, so the table stays the size of
      // an hour's mints.
      await input.database.batch([
        input.database.prepare("delete from sandbox_passes where expires_at <= ?").bind(now()),
        input.database
          .prepare(
            `insert into sandbox_passes
               (jti, audience, user_id, org_id, project_id, workspace_id, session_id, issued_at, expires_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            pass.jti,
            pass.audience,
            pass.scope.userId,
            pass.scope.orgId,
            pass.scope.projectId ?? null,
            pass.scope.workspaceId,
            pass.scope.sessionId ?? null,
            pass.issuedAt,
            pass.expiresAt,
          ),
      ])
    },
    async revoked(jti) {
      const row = await input.database
        .prepare("select 1 as present from sandbox_passes where jti = ? and revoked_at is not null")
        .bind(jti)
        .first<{ present: number }>()
      return row !== null
    },
    async revoke(revocation) {
      const result = await input.database
        .prepare(
          `update sandbox_passes set revoked_at = ?, revoked_reason = ?
           where workspace_id = ? and revoked_at is null and expires_at > ?
             and (? is null or audience = ?)`,
        )
        .bind(now(), revocation.reason, revocation.workspaceId, now(), revocation.audience ?? null, revocation.audience ?? null)
        .run()
      return result.meta.changes
    },
    async outstanding(filter) {
      const rows = await input.database
        .prepare(
          `select jti, audience, user_id, org_id, project_id, workspace_id, session_id, issued_at, expires_at
           from sandbox_passes
           where org_id = ? and audience = ? and revoked_at is null and expires_at > ?
           order by issued_at, jti`,
        )
        .bind(filter.orgId, filter.audience, now())
        .all<PassRow>()
      return rows.results.map(recordOf)
    },
  }
}
