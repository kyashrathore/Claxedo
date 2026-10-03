import type { D1Database } from "@cloudflare/workers-types"
import type { SessionRef } from "@claxedo/agent-runtime-contract"
import { maySql, orgMemberSql, type AuthorizationPrincipal } from "./authorization"

export type CanonicalSessionShareTarget = { kind: "user" | "team" | "org"; id: string }

/** The same canonical user IDs used by cp/events, including every organization member. */
export async function readD1SessionShareRecipients(database: D1Database, who: AuthorizationPrincipal,
  ref: SessionRef, target: CanonicalSessionShareTarget) {
  const access = maySql(who, "manage_shares", { kind: "session", alias: "s" })
  const selector = target.kind === "user" ? "recipient.user_id = ?"
    : target.kind === "org" ? "s.org_id = ?"
      : `EXISTS (SELECT 1 FROM team_memberships member JOIN teams team ON team.team_id = member.team_id
          WHERE member.user_id = recipient.user_id AND member.team_id = ? AND member.revoked_at IS NULL
            AND team.org_id = s.org_id AND team.deleted_at IS NULL)`
  const result = await database.prepare(`
    SELECT DISTINCT recipient.user_id FROM sessions s JOIN users recipient ON recipient.state = 'active'
    JOIN actors human ON human.user_id = recipient.user_id AND human.kind = 'human' AND human.state = 'active'
    WHERE s.session_id = ? AND s.workspace_id = ? AND ${access.sql}
      AND ${orgMemberSql("s.org_id", "recipient.user_id")} AND ${selector}
    ORDER BY recipient.user_id
  `).bind(ref.sessionId, ref.workspaceId, ...access.bind, target.id).all<{ user_id: string }>()
  return result.results.map((row) => row.user_id)
}
