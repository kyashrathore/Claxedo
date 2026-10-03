import { PublicApiError } from "@claxedo/server-core/platform/errors/public-api-error"
import type { PublicApiErrorCode } from "@claxedo/helpers/api-error"
import type { D1Database } from "@cloudflare/workers-types"
import { requireText } from "./session-input"

export type SessionShareTarget =
  | { kind: "user"; id: string }
  | { kind: "org"; id: string }
  | { kind: "team"; id: string }

/** Resolve caller selectors once to the canonical identity used by grants and notices. */
export async function resolveD1SessionShareTarget(
  database: D1Database,
  args: {
    grantedToTokenIdentifier?: string
    grantedToSubject?: string
    grantedToUserId?: string
    grantedToOrgId?: string
    grantedToTeamId?: string
    grantedToTeamPublicId?: string
  },
  allowMissing = false,
): Promise<SessionShareTarget | undefined> {
  if (shareSelectorCount(args) !== 1) throw sessionShareError("session_share_target_required")
  const userSelector = args.grantedToTokenIdentifier ?? args.grantedToSubject ?? args.grantedToUserId
  if (userSelector) {
    const value = requireText(userSelector, "share user target")
    const user = args.grantedToUserId
      ? await database
          .prepare(`select user_id from users where user_id = ? and state = 'active'`)
          .bind(value)
          .first<{ user_id: string }>()
      : args.grantedToTokenIdentifier
        ? await database
            .prepare(
              `
            select ai.user_id from auth_identities ai
            join users u on u.user_id = ai.user_id and u.state = 'active'
            where ai.issuer || '|' || ai.subject = ? and ai.unlinked_at is null
          `,
            )
            .bind(value)
            .first<{ user_id: string }>()
        : await database
            .prepare(
              `
            select ai.user_id from auth_identities ai
            join users u on u.user_id = ai.user_id and u.state = 'active'
            where ai.subject = ? and ai.unlinked_at is null
            order by ai.linked_at, ai.adapter, ai.issuer limit 1
          `,
            )
            .bind(value)
            .first<{ user_id: string }>()
    if (!user) {
      if (allowMissing) return undefined
      throw sessionShareError("session_share_target_not_found")
    }
    return { kind: "user", id: user.user_id }
  }
  const orgSelector = args.grantedToOrgId
  if (orgSelector) {
    const orgId = requireText(orgSelector, "share organization target")
    const org = await database
      .prepare(`select org_id from orgs where org_id = ? and deleted_at is null`)
      .bind(orgId)
      .first<{ org_id: string }>()
    if (!org) {
      if (allowMissing) return undefined
      throw sessionShareError("session_share_target_not_found")
    }
    return { kind: "org", id: org.org_id }
  }
  const teamId = requireText(args.grantedToTeamId ?? args.grantedToTeamPublicId!, "share team target")
  const team = await database
    .prepare(`select team_id from teams where team_id = ? and deleted_at is null`)
    .bind(teamId)
    .first<{ team_id: string }>()
  if (!team) {
    if (allowMissing) return undefined
    throw sessionShareError("session_share_target_not_found")
  }
  return { kind: "team", id: team.team_id }
}


export function shareSelectorCount(args: {
  grantedToTokenIdentifier?: string
  grantedToSubject?: string
  grantedToUserId?: string
  grantedToOrgId?: string
  grantedToTeamId?: string
  grantedToTeamPublicId?: string
}) {
  return [
    args.grantedToTokenIdentifier,
    args.grantedToSubject,
    args.grantedToUserId,
    args.grantedToOrgId,
    args.grantedToTeamId,
    args.grantedToTeamPublicId,
  ].filter((value) => typeof value === "string" && !!value.trim()).length
}

export function sessionShareError(code: PublicApiErrorCode) {
  return new PublicApiError(code)
}
