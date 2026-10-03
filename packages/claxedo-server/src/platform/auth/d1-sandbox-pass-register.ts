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
  renewable: number
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
    ...(row.renewable === 1 ? { renewable: true } : {}),
  }
}

/** The hosted register over the `sandbox_passes` table of `CONTROL_PLANE_DB`. */
export function createD1SandboxPassRegister(input: { database: D1Database; now?: () => number }): SandboxPassRegister {
  const now = input.now ?? Date.now
  return {
    async record(pass, options) {
      // Pruning rides on the mint rather than on a schedule this Worker does
      // not have. Ordinary passes live at most an hour; renewable proofs keep
      // the client's last received ticket until it acknowledges a replacement.
      const result = await input.database.batch([
        input.database.prepare("delete from sandbox_passes where expires_at <= ? and (renewable = 0 or revoked_at is not null)").bind(now()),
        input.database
          .prepare(
            `insert into sandbox_passes
               (jti, audience, user_id, org_id, project_id, workspace_id, session_id, issued_at, expires_at, renewable)
             select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             ${options ? `where ? = 1 and exists (select 1 from sandbox_passes previous
               where previous.jti = ? and previous.renewable = 1 and previous.revoked_at is null
                 and previous.audience = ? and previous.user_id = ? and previous.org_id = ? and previous.workspace_id = ?
                 and previous.project_id is ? and previous.session_id is ?)` : ""}`,
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
            pass.renewable ? 1 : 0,
            ...(options ? [pass.renewable ? 1 : 0, options.renewalOf, pass.audience, pass.scope.userId,
              pass.scope.orgId, pass.scope.workspaceId, pass.scope.projectId ?? null, pass.scope.sessionId ?? null] : []),
          ),
      ])
      if (options && result[1]?.meta.changes !== 1) throw new Error("Sandbox proof renewal ended before registration")
    },
    async revoked(jti) {
      const row = await input.database
        .prepare("select 1 as present from sandbox_passes where jti = ? and revoked_at is not null")
        .bind(jti)
        .first<{ present: number }>()
      return row !== null
    },
    async renewable(jti) {
      return !!await input.database.prepare("select 1 from sandbox_passes where jti = ? and renewable = 1 and revoked_at is null").bind(jti).first()
    },
    async acknowledge(jti) {
      await input.database.prepare(`delete from sandbox_passes as retired
        where retired.jti <> ? and retired.renewable = 1 and retired.expires_at <= ?
          and exists (select 1 from sandbox_passes held where held.jti = ? and held.renewable = 1 and held.revoked_at is null
            and held.audience = retired.audience and held.workspace_id = retired.workspace_id
            and held.user_id = retired.user_id and held.org_id = retired.org_id
            and held.project_id is retired.project_id and held.session_id is retired.session_id)`)
        .bind(jti, now(), jti).run()
    },
    async revoke(revocation) {
      const result = await input.database
        .prepare(
          `update sandbox_passes set revoked_at = ?, revoked_reason = ?
           where workspace_id = ? and revoked_at is null and (expires_at > ? or renewable = 1)
             and (? is null or user_id = ?)
             and (? is null or org_id = ?)
             and (? is null or audience = ?)`,
        )
        .bind(
          now(), revocation.reason, revocation.workspaceId, now(),
          revocation.userId ?? null, revocation.userId ?? null,
          revocation.orgId ?? null, revocation.orgId ?? null,
          revocation.audience ?? null, revocation.audience ?? null,
        )
        .run()
      return result.meta.changes
    },
    async outstanding(filter) {
      const rows = await input.database
        .prepare(
          `select jti, audience, user_id, org_id, project_id, workspace_id, session_id, issued_at, expires_at, renewable
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
