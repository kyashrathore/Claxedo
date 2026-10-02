import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  isOrgMemberRole,
  type OrgInvitation,
  type OrgInvitationDelivery,
  type OrgMemberRole,
} from "@claxedo/server-core/platform/auth/org-access-authority"
import { accessAuditStatement, D1AccessAuthorityError, requireText, type AccessPrincipal, type D1AccessContext } from "./access-context"
import { may, mayGuard, maySql, type BoundSql } from "./authorization"
import { D1OrgMemberAuthority } from "./org-member-authority"

export const D1_ORG_INVITATION_AUTHORITY_METHODS = [
  "createOrgInvitation",
  "listOrgInvitations",
  "revokeOrgInvitation",
  "acceptOrgInvitation",
] as const satisfies readonly (keyof WorkspaceAuthority)[]
export type D1OrgInvitationAuthorityPort = Pick<
  WorkspaceAuthority,
  (typeof D1_ORG_INVITATION_AUTHORITY_METHODS)[number]
>

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const INVITATION_RATE_WINDOW_MS = 60 * 60 * 1000
const INVITATION_RATE_LIMIT = 20
const PUBLIC_COLUMNS = "id, org_id, email, role, invited_by, created_at, expires_at, accepted_at, revoked_at"

type StoredInvitation = OrgInvitation & { token_hash: string }

export async function invitationTokenHash(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export class D1OrgInvitationAuthority implements D1OrgInvitationAuthorityPort {
  constructor(
    private readonly context: D1AccessContext,
    private readonly delivery?: OrgInvitationDelivery,
  ) {}

  async createOrgInvitation(auth: SignedControlPlaneAuth, args: { orgId: string; email: string; role: OrgMemberRole }) {
    const who = await this.context.principal(auth)
    const orgId = await this.adminOrganization(who, args.orgId)
    const email = requireText(args.email, "email").toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !isOrgMemberRole(args.role))
      throw new D1AccessAuthorityError("invalid_input")
    if (args.role === "owner" && !(await may(this.context.database, who, "own", { kind: "org", orgId }))) {
      throw new D1AccessAuthorityError("org_owner_required")
    }
    if (!this.delivery?.sendInvitation) throw new D1AccessAuthorityError("org_invitation_delivery_unavailable")
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")
    const tokenHash = await invitationTokenHash(token)
    const now = this.context.now()
    const invitationId = `inv_${crypto.randomUUID()}`
    const administers = maySql(who, args.role === "owner" ? "own" : "administer", { kind: "org", orgId: "org.org_id" })
    const permitted = {
      sql: `exists (select 1 from orgs org where org.org_id = ? and org.deleted_at is null and ${administers.sql})
        and not exists (
          select 1 from org_invitations where org_id = ? and email = ?
            and accepted_at is null and revoked_at is null and expires_at > ?
        )
        and (select count(*) from org_invitations where org_id = ? and created_at > ?) < ?`,
      bind: [orgId, ...administers.bind, orgId, email, now, orgId, now - INVITATION_RATE_WINDOW_MS, INVITATION_RATE_LIMIT],
    }
    const [, result] = await this.context.database.batch([
      accessAuditStatement(this.context, {
        who,
        action: "org.invitation.created",
        metadata: {
          sql: "json_object('orgId', ?, 'invitationId', ?, 'email', ?, 'role', ?)",
          bind: [orgId, invitationId, email, args.role],
        },
        guard: permitted,
        now,
      }),
      this.context.database
        .prepare(
          `
        insert into org_invitations (id, org_id, email, role, token_hash, invited_by, created_at, expires_at)
        select ?, ?, ?, ?, ?, ?, ?, ? where ${permitted.sql}
      `,
        )
        .bind(invitationId, orgId, email, args.role, tokenHash, who.userId, now, now + INVITATION_TTL_MS, ...permitted.bind),
    ])
    if (result.meta.changes !== 1) {
      await this.adminOrganization(who, orgId)
      if (args.role === "owner" && !(await may(this.context.database, who, "own", { kind: "org", orgId })))
        throw new D1AccessAuthorityError("org_owner_required")
      const pending = await this.context.database
        .prepare("select 1 from org_invitations where org_id = ? and email = ? and accepted_at is null and revoked_at is null and expires_at > ?")
        .bind(orgId, email, now)
        .first()
      throw new D1AccessAuthorityError(pending ? "org_invitation_pending" : "org_invitation_rate_limited")
    }
    try {
      await this.delivery.sendInvitation({ email, token })
    } catch {
      await this.revokePendingInvitation(who, { orgId, invitationId }, { sql: "1 = 1", bind: [] })
      console.error("Organization invitation delivery failed")
    }
  }

  async listOrgInvitations(auth: SignedControlPlaneAuth, args: { orgId: string }): Promise<OrgInvitation[]> {
    const who = await this.context.principal(auth)
    const orgId = await this.adminOrganization(who, args.orgId)
    return (
      await this.context.database
        .prepare(`select ${PUBLIC_COLUMNS} from org_invitations where org_id = ? order by created_at desc, id`)
        .bind(orgId)
        .all<OrgInvitation>()
    ).results
  }

  async revokeOrgInvitation(auth: SignedControlPlaneAuth, args: { orgId: string; invitationId: string }) {
    const who = await this.context.principal(auth)
    const orgId = await this.adminOrganization(who, args.orgId)
    const invitationId = requireText(args.invitationId, "invitationId")
    return this.revokePendingInvitation(who, { orgId, invitationId }, mayGuard(who, "administer", { kind: "org", orgId }))
  }

  private async revokePendingInvitation(who: AccessPrincipal, args: { orgId: string; invitationId: string }, permission: BoundSql) {
    const { orgId, invitationId } = args
    const now = this.context.now()
    const pending = {
      sql: `exists (
        select 1 from org_invitations invitation
        where invitation.id = ? and invitation.org_id = ? and invitation.revoked_at is null and invitation.accepted_at is null
          and ${permission.sql}
      )`,
      bind: [invitationId, orgId, ...permission.bind],
    }
    const [, result] = await this.context.database.batch([
      accessAuditStatement(this.context, {
        who,
        action: "org.invitation.revoked",
        metadata: { sql: "json_object('orgId', ?, 'invitationId', ?)", bind: [orgId, invitationId] },
        guard: pending,
        now,
      }),
      this.context.database
        .prepare(`update org_invitations set revoked_at = ? where id = ? and ${pending.sql}`)
        .bind(now, invitationId, ...pending.bind),
      ...retireOrphanedInvitationUsers(this.context, { invitationId, orgId, now, permission }),
    ])
    return { revoked: result.meta.changes === 1 }
  }

  async acceptOrgInvitation(auth: SignedControlPlaneAuth, args: { token: string }) {
    const who = await this.context.principal(auth)
    const tokenHash = await invitationTokenHash(requireText(args.token, "token"))
    const invitation = await this.context.database
      .prepare("select * from org_invitations where token_hash = ? and accepted_at is null")
      .bind(tokenHash)
      .first<StoredInvitation>()
    if (
      !invitation ||
      invitation.accepted_at !== null ||
      invitation.revoked_at !== null ||
      invitation.expires_at <= this.context.now()
    ) {
      throw new D1AccessAuthorityError("org_invitation_invalid")
    }
    this.context.assertOrganizationAllowed(invitation.org_id)
    const email = await this.delivery?.verifiedEmail(auth)
    if (!email || email.trim().toLowerCase() !== invitation.email)
      throw new D1AccessAuthorityError("org_invitation_email_mismatch")
    return new D1OrgMemberAuthority(this.context).acceptInvitationMembership(who, invitation)
  }

  private async adminOrganization(who: AccessPrincipal, value: string) {
    const orgId = requireText(value, "orgId")
    this.context.assertOrganizationAllowed(orgId)
    if (!(await may(this.context.database, who, "administer", { kind: "org", orgId })))
      throw new D1AccessAuthorityError("org_admin_required")
    return orgId
  }
}

export async function prepareInvitationAdmission(context: D1AccessContext, input: {
  orgId: string
  email: string
  now: number
}) {
  const now = input.now
  const email = input.email.trim().toLowerCase()
  const invitation = await context.database
    .prepare(`select * from org_invitations where org_id = ? and email = ?
      and accepted_at is null and revoked_at is null and expires_at > ? order by created_at desc, id limit 1`)
    .bind(input.orgId, email, now)
    .first<OrgInvitation>()
  if (!invitation) return
  const inviter = maySql({ userId: invitation.invited_by }, invitation.role === "owner" ? "own" : "administer", { kind: "org", orgId: "invitation.org_id" })
  const guard = {
    sql: `exists (select 1 from org_invitations invitation where invitation.id = ?
      and invitation.org_id = ? and invitation.email = ? and invitation.invited_by = ?
      and invitation.accepted_at is null and invitation.revoked_at is null and invitation.expires_at > ?
      and ${inviter.sql})`,
    bind: [invitation.id, input.orgId, email, invitation.invited_by, now, ...inviter.bind],
  }
  return {
    guard,
    recordUser: (userId: string) => context.database
      .prepare(`insert into org_invitation_admissions (user_id, invitation_id)
        select ?, ? where exists (select 1 from users where user_id = ?)
        on conflict (user_id) do nothing`)
      .bind(userId, invitation.id, userId),
  }
}

/**
 * Retires the people this invitation's address admitted who joined nothing and
 * have no other pending invitation: their identity goes, so their next sign-in
 * is refused again (and a later invitation admits them afresh), and their user
 * and actor are marked deleted and revoked rather than removed, so audit rows
 * and any row that references them stay intact.
 */
function retireOrphanedInvitationUsers(context: D1AccessContext, input: {
  invitationId: string
  orgId: string
  now: number
  permission: BoundSql
}) {
  const orphan = `user_id in (
    select admission.user_id from org_invitation_admissions admission
    join org_invitations admitted on admitted.id = admission.invitation_id
    join org_invitations revoked on revoked.email = admitted.email
    where revoked.id = ? and revoked.org_id = ? and revoked.revoked_at = ? and revoked.accepted_at is null
      and ${input.permission.sql}
      and not exists (select 1 from org_memberships member where member.user_id = admission.user_id)
      and not exists (select 1 from orgs org where org.owner_user_id = admission.user_id)
      and not exists (select 1 from org_invitations other where other.email = admitted.email
        and other.accepted_at is null and other.revoked_at is null and other.expires_at > ?)
  )`
  const bind = [input.invitationId, input.orgId, input.now, ...input.permission.bind, input.now]
  const now = input.now
  // The admission row is the candidate marker, so it goes last and every earlier statement sees the same set.
  return [
    context.database.prepare(`delete from auth_identities where ${orphan}`).bind(...bind),
    context.database.prepare(`update actors set state = 'revoked', revoked_at = ?, updated_at = ? where kind = 'human' and state = 'active' and ${orphan}`).bind(now, now, ...bind),
    context.database.prepare(`update users set state = 'deleted', deleted_at = ?, updated_at = ? where state = 'active' and ${orphan}`).bind(now, now, ...bind),
    context.database.prepare(`delete from org_invitation_admissions where ${orphan}`).bind(...bind),
  ]
}
