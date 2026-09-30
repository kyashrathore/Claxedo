import type { D1Database } from "@cloudflare/workers-types"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type { MemberSelector } from "@claxedo/server-core/platform/auth/org-access-authority"
import { activeOrgMemberSql, organizationAdminSql } from "./project-role"

export type AccessPrincipal = { userId: string; actorId: string }

/**
 * What the organization, team and project-member modules share with the
 * workspace authority that resolves their callers: one database, one
 * deployment, one clock, one principal cache per request, and the product's
 * rule on which organizations may be addressed at all.
 */
export type D1AccessContext = {
  database: D1Database
  deploymentId: string
  now: () => number
  randomId: (prefix: "team" | "audit") => string
  principal: (auth: SignedControlPlaneAuth) => Promise<AccessPrincipal>
  assertOrganizationAllowed: (orgId: string) => void
}

const ACCESS_ERROR_STATUS = {
  invalid_input: 400,
  org_admin_required: 403,
  org_owner_required: 403,
  org_owner_protected: 409,
  org_membership_required: 403,
  org_member_not_found: 404,
  org_member_target_required: 400,
  organization_not_found: 404,
  team_not_found: 404,
  team_not_allowed_on_personal_org: 400,
  team_member_not_found: 404,
  team_member_org_membership_required: 403,
  team_member_target_required: 400,
  project_not_found: 404,
  project_admin_required: 403,
  project_member_not_found: 404,
  project_member_org_membership_required: 403,
  project_member_owner_immutable: 409,
  resource_conflict: 409,
} as const

export type D1AccessErrorCode = keyof typeof ACCESS_ERROR_STATUS

export class D1AccessAuthorityError extends ClaxedoError<D1AccessErrorCode> {
  constructor(code: D1AccessErrorCode, message: string = code) {
    super({ code, message, status: ACCESS_ERROR_STATUS[code] })
  }
}

export function requireText(value: string, name: string) {
  const result = value.trim()
  if (!result || result.length > 512) {
    throw new D1AccessAuthorityError("invalid_input", `${name} must be a non-empty string of at most 512 characters`)
  }
  return result
}

export async function canAdminOrganization(database: D1Database, userId: string, orgId: string) {
  return !!(await database.prepare(`select ${organizationAdminSql("?", "?")} as allowed`)
    .bind(userId, orgId, userId).first<{ allowed: number }>())?.allowed
}

export async function isActiveOrgMember(database: D1Database, userId: string, orgId: string) {
  return !!(await database.prepare(`select ${activeOrgMemberSql("?", "?")} as present`)
    .bind(userId, orgId, userId).first<{ present: number }>())?.present
}

/**
 * The active user exactly one selector names: their public id (the canonical
 * user id), a provider token identifier (`issuer|subject`), or a provider
 * subject. Nothing when the named person has no active account.
 */
export async function resolveMemberUser(
  database: D1Database,
  selectors: MemberSelector,
  targetRequired: "team_member_target_required" | "org_member_target_required",
) {
  const named = [selectors.tokenIdentifier, selectors.providerSubject, selectors.userPublicId].filter(
    (value): value is string => typeof value === "string" && !!value.trim(),
  )
  if (named.length !== 1) throw new D1AccessAuthorityError(targetRequired)
  if (selectors.userPublicId?.trim()) {
    return await database
      .prepare(`select user_id from users where user_id = ? and state = 'active'`)
      .bind(requireText(selectors.userPublicId, "userPublicId"))
      .first<{ user_id: string }>()
  }
  if (selectors.tokenIdentifier?.trim()) {
    return await database
      .prepare(`
        select ai.user_id from auth_identities ai join users u on u.user_id = ai.user_id and u.state = 'active'
        where ai.issuer || '|' || ai.subject = ? and ai.unlinked_at is null
      `)
      .bind(requireText(selectors.tokenIdentifier, "tokenIdentifier"))
      .first<{ user_id: string }>()
  }
  return await database
    .prepare(`
      select ai.user_id from auth_identities ai join users u on u.user_id = ai.user_id and u.state = 'active'
      where ai.subject = ? and ai.unlinked_at is null
      order by ai.linked_at, ai.adapter, ai.issuer limit 1
    `)
    .bind(requireText(selectors.providerSubject!, "providerSubject"))
    .first<{ user_id: string }>()
}

/** A SQL expression and the values its placeholders take, in order. */
export type BoundSql = { sql: string; bind: unknown[] }

/**
 * The audit row for one membership or grant change, attributed to the caller
 * and written in the same batch as the change. It is placed BEFORE the change
 * so `metadata` reads the prior role, and it carries the change's own guard so
 * a change the guard refuses leaves no row either.
 */
export function accessAuditStatement(context: D1AccessContext, input: {
  who: AccessPrincipal
  action: string
  metadata: BoundSql
  guard: BoundSql
  now: number
}) {
  return context.database.prepare(`
    insert into authority_audit_events (
      event_id, deployment_id, user_id, actor_id, org_id, project_id, workspace_id,
      unverified_attempted_workspace_id, action, result, reason, metadata_json, created_at
    )
    select ?, ?, ?, ?, null, null, null, null, ?, 'allow', null, ${input.metadata.sql}, ?
    where ${input.guard.sql}
  `).bind(
    context.randomId("audit"),
    context.deploymentId,
    input.who.userId,
    input.who.actorId,
    input.action,
    ...input.metadata.bind,
    input.now,
    ...input.guard.bind,
  )
}
