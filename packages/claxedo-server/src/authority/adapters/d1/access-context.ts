import { createRequireText } from "@claxedo/helpers"
import { PUBLIC_API_ERRORS } from "@claxedo/helpers/api-error"
import type { D1Database } from "@cloudflare/workers-types"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type { FindAccountByEmail, MemberSelector } from "@claxedo/server-core/platform/auth/org-access-authority"
import type { BoundSql } from "./authorization"

export type AccessPrincipal = { userId: string; actorId: string }

/**
 * What the organization, team and project-member modules share with the
 * workspace authority: one database, one deployment, one clock, the caller as
 * `requireHuman` resolves it, and the product's rule on which organizations
 * may be addressed at all.
 */
export type D1AccessContext = {
  database: D1Database
  deploymentId: string
  now: () => number
  randomId: (prefix: "team" | "audit") => string
  principal: (auth: SignedControlPlaneAuth) => Promise<AccessPrincipal>
  assertOrganizationAllowed: (orgId: string) => void
  findAccountByEmail?: FindAccountByEmail
}

export type HumanPrincipal = { userId: string; actorId: string; actorKind: "human" }

type IdentityRow = {
  user_id: string
  user_state: "active" | "suspended" | "deleted"
  actor_id: string
  actor_kind: "human" | "agent"
  actor_state: "active" | "suspended" | "revoked"
  unlinked_at: number | null
}

/**
 * One request = one `SignedControlPlaneAuth` object, and a request asks
 * several D1 authority classes for its principal (the route's own lookup, then
 * every store and port it calls). The identity row cannot change the answer
 * within that request, so it is read once per auth object and database; a
 * refusal is not remembered.
 */
const resolved = new WeakMap<SignedControlPlaneAuth, WeakMap<D1Database, Map<string, Promise<HumanPrincipal>>>>()

/**
 * The signed caller as this deployment's active human: the identity is still
 * linked to the user the token names, the actor is that user's human actor,
 * and both are active.
 */
export function requireHuman(database: D1Database, deploymentId: string, auth: SignedControlPlaneAuth): Promise<HumanPrincipal> {
  let byDatabase = resolved.get(auth)
  if (!byDatabase) resolved.set(auth, (byDatabase = new WeakMap()))
  let byDeployment = byDatabase.get(database)
  if (!byDeployment) byDatabase.set(database, (byDeployment = new Map()))
  const existing = byDeployment.get(deploymentId)
  if (existing) return existing
  const pending = resolveHuman(database, deploymentId, auth).catch((cause: unknown) => {
    byDeployment.delete(deploymentId)
    throw cause
  })
  byDeployment.set(deploymentId, pending)
  return pending
}

async function resolveHuman(database: D1Database, deploymentId: string, auth: SignedControlPlaneAuth): Promise<HumanPrincipal> {
  const principal = auth.principal
  if (!principal) throw new ControlPlaneAuthError(503, "identity_provisioning", "Canonical application identity is required")
  if (principal.deploymentId !== deploymentId || principal.actorKind !== "human") {
    throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Application principal belongs to another authority domain")
  }
  const row = await database
    .prepare(`
      select identity.user_id, person.state as user_state, actor.actor_id, actor.kind as actor_kind,
        actor.state as actor_state, identity.unlinked_at
      from auth_identities identity
      join users person on person.user_id = identity.user_id
      join actors actor on actor.actor_id = ? and actor.user_id = person.user_id
      where identity.adapter = ? and identity.issuer = ? and identity.subject = ?
    `)
    .bind(principal.actorId, principal.identity.adapter, principal.identity.issuer, principal.identity.subject)
    .first<IdentityRow>()
  if (
    !row || row.unlinked_at !== null || row.user_id !== principal.userId
    || row.actor_id !== principal.actorId || row.actor_kind !== "human"
  ) throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Application principal is stale or unlinked")
  if (row.user_state === "deleted") throw new ControlPlaneAuthError(403, "account_deleted", "Application account is deleted")
  if (row.user_state !== "active" || row.actor_state !== "active") {
    throw new ControlPlaneAuthError(403, "account_suspended", "Application account is suspended")
  }
  return { userId: row.user_id, actorId: row.actor_id, actorKind: "human" }
}

export type D1AccessErrorCode =
  | "invalid_input"
  | "org_admin_required"
  | "org_owner_required"
  | "org_owner_protected"
  | "org_membership_required"
  | "org_member_not_found"
  | "org_member_target_required"
  | "org_member_email_unsupported"
  | "organization_not_found"
  | "team_not_found"
  | "team_not_allowed_on_personal_org"
  | "team_member_not_found"
  | "team_member_org_membership_required"
  | "team_member_target_required"
  | "project_not_found"
  | "project_admin_required"
  | "project_member_not_found"
  | "project_member_org_membership_required"
  | "project_member_owner_immutable"
  | "resource_conflict"

export class D1AccessAuthorityError extends ClaxedoError<D1AccessErrorCode> {
  constructor(code: D1AccessErrorCode, message: string = code) {
    super({ code, message, status: PUBLIC_API_ERRORS[code].status })
  }
}

export const { requireText, optionalText } = createRequireText((message) => new D1AccessAuthorityError("invalid_input", message))

/**
 * The active user exactly one selector names: their public id (the canonical
 * user id), a verified email the deployment's identity provider holds, a
 * provider token identifier (`issuer|subject`), or a provider subject.
 * Nothing when the named person has no active account. Callers resolve only
 * after authorizing the change, so an unauthorized caller cannot learn from
 * the answer whether an address has an account.
 */
export async function resolveMemberUser(
  context: D1AccessContext,
  selectors: MemberSelector,
  targetRequired: "team_member_target_required" | "org_member_target_required",
): Promise<{ user_id: string } | null> {
  const database = context.database
  const named = [selectors.tokenIdentifier, selectors.providerSubject, selectors.userPublicId, selectors.email].filter(
    (value): value is string => typeof value === "string" && !!value.trim(),
  )
  if (named.length !== 1) throw new D1AccessAuthorityError(targetRequired)
  if (selectors.email?.trim()) {
    if (!context.findAccountByEmail) throw new D1AccessAuthorityError("org_member_email_unsupported")
    const account = await context.findAccountByEmail(requireText(selectors.email, "email"))
    return account ? await resolveMemberUser(context, { tokenIdentifier: account.tokenIdentifier }, targetRequired) : null
  }
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

const ACCESS_CHANGE_ACTION_PREFIXES = ["org.", "team.", "project.member."] as const

export type AccessChangeAction = `${(typeof ACCESS_CHANGE_ACTION_PREFIXES)[number]}${string}`

/** True for an audit row an access change wrote; `action` and `result` are its columns. */
export function accessChangeRowSql(action: string, result: string) {
  const prefixed = ACCESS_CHANGE_ACTION_PREFIXES
    .map((prefix) => `substr(${action}, 1, ${prefix.length}) = '${prefix}'`)
    .join(" or ")
  return `(${result} = 'allow' and (${prefixed}))`
}

/**
 * The audit row for one membership or grant change, attributed to the caller
 * and written in the same batch as the change. It is placed BEFORE the change
 * so `metadata` reads the prior role, and it carries the change's own complete
 * guard so a change the guard refuses leaves no row either.
 *
 * `rows` audits a set change one row per target: a `from ... where ...` clause
 * naming the targets, with `key` telling their event ids apart. `metadata` is
 * then written over that clause's aliases.
 */
export function accessAuditStatement(context: D1AccessContext, input: {
  who: AccessPrincipal
  action: AccessChangeAction
  metadata: BoundSql
  guard: BoundSql
  now: number
  rows?: BoundSql & { key: string }
}) {
  const rows = input.rows
  return context.database.prepare(`
    insert into authority_audit_events (
      event_id, deployment_id, user_id, actor_id, org_id, project_id, workspace_id,
      unverified_attempted_workspace_id, action, result, reason, metadata_json, created_at
    )
    select ?${rows ? ` || '/' || ${rows.key}` : ""}, ?, ?, ?, null, null, null, null, ?, 'allow', null, ${input.metadata.sql}, ?
    ${rows ? `${rows.sql} and` : "where"} ${input.guard.sql}
  `).bind(
    context.randomId("audit"),
    context.deploymentId,
    input.who.userId,
    input.who.actorId,
    input.action,
    ...input.metadata.bind,
    input.now,
    ...(rows?.bind ?? []),
    ...input.guard.bind,
  )
}

/**
 * The owner memberships an organization's bootstrap writes (a personal
 * organization, a created one, a user-deployed deployment's configured or
 * claimed owner), each preceded by its audit row, attributed to the new
 * owner. `owners` selects `org_id, user_id` pairs and may read rows written
 * earlier in the same batch. A membership already present in any state is
 * neither written again nor audited, so a replayed bootstrap writes nothing.
 */
export function ownerMembershipStatements(context: D1AccessContext, input: { owners: BoundSql; now: number }) {
  const action: AccessChangeAction = "org.member.added"
  return [
    context.database.prepare(`
      insert into authority_audit_events (
        event_id, deployment_id, user_id, actor_id, org_id, project_id, workspace_id,
        unverified_attempted_workspace_id, action, result, reason, metadata_json, created_at
      )
      select ? || '/' || owner.org_id, ?, owner.user_id,
        (select actor_id from actors where user_id = owner.user_id and kind = 'human'),
        null, null, null, null, ?, 'allow', null,
        json_object('orgId', owner.org_id, 'targetUserId', owner.user_id, 'before', null, 'after', 'owner'), ?
      from (${input.owners.sql}) owner
      where not exists (
        select 1 from org_memberships existing where existing.org_id = owner.org_id and existing.user_id = owner.user_id
      )
    `).bind(context.randomId("audit"), context.deploymentId, action, input.now, ...input.owners.bind),
    context.database.prepare(`
      insert into org_memberships (org_id, user_id, role, created_at, updated_at, revoked_at)
      select owner.org_id, owner.user_id, 'owner', ?, ?, null
      from (${input.owners.sql}) owner
      where true
      on conflict (org_id, user_id) do nothing
    `).bind(input.now, input.now, ...input.owners.bind),
  ]
}
