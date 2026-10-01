import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { OrgMember, OrgMemberRole } from "@claxedo/server-core/platform/auth/org-access-authority"
import {
  accessAuditStatement,
  D1AccessAuthorityError,
  requireText,
  type AccessPrincipal,
  type D1AccessContext,
} from "./access-context"
import { may, maySql, type BoundSql } from "./authorization"

export const D1_ORG_MEMBER_AUTHORITY_METHODS = [
  "listOrgMembers",
  "updateOrgMember",
  "removeOrgMember",
] as const satisfies readonly (keyof WorkspaceAuthority)[]

export type D1OrgMemberAuthorityPort = Pick<WorkspaceAuthority, (typeof D1_ORG_MEMBER_AUTHORITY_METHODS)[number]>

type MembershipState = { founder: boolean; role: OrgMemberRole | null }

/**
 * Who belongs to an organization and with which role. Owners and admins
 * change membership; only an owner grants, changes or removes the owner role;
 * the founding owner (`orgs.owner_user_id`) is an owner for as long as the
 * organization exists, which is what keeps every organization owned.
 */
export class D1OrgMemberAuthority implements D1OrgMemberAuthorityPort {
  constructor(private readonly context: D1AccessContext) {}

  private get database() {
    return this.context.database
  }

  async listOrgMembers(auth: SignedControlPlaneAuth, args: { orgId: string }): Promise<OrgMember[]> {
    const who = await this.context.principal(auth)
    const orgId = requireText(args.orgId, "orgId")
    if (!(await may(this.database, who, "member", { kind: "org", orgId }))) return []
    const result = await this.database
      .prepare(`
        select member.user_id, member.user_id as public_id,
          case when org.owner_user_id = member.user_id then 'owner' else member.role end as role,
          member.created_at as joined_at
        from org_memberships member
        join orgs org on org.org_id = member.org_id and org.deleted_at is null
        join users person on person.user_id = member.user_id and person.state = 'active'
        where member.org_id = ? and member.revoked_at is null
        order by case when org.owner_user_id = member.user_id or member.role = 'owner' then 3
          when member.role = 'admin' then 2 else 1 end desc, member.created_at, member.user_id
      `)
      .bind(orgId)
      .all<OrgMember>()
    return result.results
  }

  async updateOrgMember(auth: SignedControlPlaneAuth, args: { orgId: string; userPublicId: string; role: OrgMemberRole }) {
    const who = await this.context.principal(auth)
    const orgId = await this.adminOrganization(who, args.orgId)
    const userId = requireText(args.userPublicId, "userPublicId")
    if ((await this.membership(orgId, userId)).role === null) throw new D1AccessAuthorityError("org_member_not_found")
    return await this.setRole(who, orgId, userId, args.role)
  }

  // Re-admission must restore none of the grants or tokens revoked by this
  // batch. Workspace and project ownership survive leaving the organization.
  async removeOrgMember(auth: SignedControlPlaneAuth, args: { orgId: string; userPublicId: string }) {
    const who = await this.context.principal(auth)
    const orgId = await this.adminOrganization(who, args.orgId)
    const userId = requireText(args.userPublicId, "userPublicId")
    const current = await this.membership(orgId, userId)
    if (current.role === null) {
      return {
        removed: false,
        team_memberships_revoked: 0,
        project_memberships_revoked: 0,
        session_shares_revoked: 0,
        runtime_tokens_revoked: 0,
      }
    }
    await this.assertOwnershipChange(who, orgId, current, null)
    const now = this.context.now()
    const guard = this.changeGuard(who, orgId, userId, null)
    // Their shares go both ways: the ones naming them, and the ones they made
    // on their own workspaces' sessions, with the tokens those admitted.
    const ownedWorkspaces = `select workspace_id from workspaces where owner_user_id = ? and org_id = ?`
    const shares = `session_share_grants where org_id = ? and revoked_at is null
      and (target_user_id = ? or workspace_id in (${ownedWorkspaces}))`
    const [, tokens, sessionShares, teams, projects, membership] = await this.database.batch([
      accessAuditStatement(this.context, {
        who,
        action: "org.member.removed",
        metadata: {
          sql: `json_object('orgId', ?, 'targetUserId', ?,
            'before', (select role from org_memberships where org_id = ? and user_id = ? and revoked_at is null),
            'after', null,
            'sessionSharesRevoked', (select count(*) from ${shares}))`,
          bind: [orgId, userId, orgId, userId, orgId, userId, userId, orgId],
        },
        guard,
        now,
      }),
      this.database
        .prepare(`
          update runtime_access_tokens set revoked_at = ?
          where revoked_at is null and deployment_id = ? and org_id = ?
            and (minted_for_user_id = ? or (session_id is not null and workspace_id in (${ownedWorkspaces})))
            and ${guard.sql}
        `)
        .bind(now, this.context.deploymentId, orgId, userId, userId, orgId, ...guard.bind),
      this.database
        .prepare(`update session_share_grants set revoked_at = ? where rowid in (select rowid from ${shares}) and ${guard.sql}`)
        .bind(now, orgId, userId, userId, orgId, ...guard.bind),
      this.database
        .prepare(`
          update team_memberships set revoked_at = ?, updated_at = ?
          where user_id = ? and revoked_at is null
            and team_id in (select team_id from teams where org_id = ?)
            and ${guard.sql}
        `)
        .bind(now, now, userId, orgId, ...guard.bind),
      this.database
        .prepare(`
          update project_memberships set revoked_at = ?, updated_at = ?
          where user_id = ? and revoked_at is null and role <> 'owner'
            and project_id in (select project_id from projects where org_id = ?)
            and ${guard.sql}
        `)
        .bind(now, now, userId, orgId, ...guard.bind),
      this.database
        .prepare(`
          update org_memberships set revoked_at = ?, updated_at = ?
          where org_id = ? and user_id = ? and revoked_at is null and ${guard.sql}
        `)
        .bind(now, now, orgId, userId, ...guard.bind),
    ])
    if ((membership.meta.changes ?? 0) === 0) {
      throw new D1AccessAuthorityError("resource_conflict", "Organization membership changed concurrently")
    }
    return {
      removed: true,
      team_memberships_revoked: teams.meta.changes ?? 0,
      project_memberships_revoked: projects.meta.changes ?? 0,
      session_shares_revoked: sessionShares.meta.changes ?? 0,
      runtime_tokens_revoked: tokens.meta.changes ?? 0,
    }
  }

  /**
   * The batch rechecks the invitation, inviter authority and accepting person
   * before writing membership and audit, so concurrent revocation, expiry or
   * loss of authority cannot confer membership.
   */
  async acceptInvitationMembership(
    who: AccessPrincipal,
    invitation: { id: string; org_id: string; role: OrgMemberRole; token_hash: string; email: string; invited_by: string },
  ) {
    const now = this.context.now()
    const inviter = maySql({ userId: invitation.invited_by }, invitation.role === "owner" ? "own" : "administer", { kind: "org", orgId: "invitation.org_id" })
    const guard: BoundSql = {
      sql: `exists (
        select 1 from org_invitations invitation
        join orgs org on org.org_id = invitation.org_id and org.deleted_at is null
        join users person on person.user_id = ? and person.state = 'active'
        join actors actor on actor.actor_id = ? and actor.user_id = person.user_id and actor.kind = 'human' and actor.state = 'active'
        where invitation.id = ? and invitation.org_id = ? and invitation.role = ? and invitation.token_hash = ? and invitation.email = ?
          and invitation.accepted_at is null and invitation.revoked_at is null and invitation.expires_at > ?
          and invitation.invited_by = ? and ${inviter.sql}
          and (org.owner_user_id <> person.user_id or invitation.role = 'owner')
          and not exists (
            select 1 from org_memberships member
            where member.org_id = invitation.org_id and member.user_id = person.user_id and member.revoked_at is null
          )
      )`,
      bind: [who.userId, who.actorId, invitation.id, invitation.org_id, invitation.role, invitation.token_hash, invitation.email, now, invitation.invited_by, ...inviter.bind],
    }
    // D1 batches share a transaction; the final changes() observes the preceding membership write.
    const [, membership, accepted] = await this.database.batch([
      accessAuditStatement(this.context, {
        who,
        action: "org.member.added",
        metadata: {
          sql: `json_object('orgId', ?, 'targetUserId', ?, 'before', null, 'after', ?, 'invitationId', ?, 'inviterUserId', ?)`,
          bind: [invitation.org_id, who.userId, invitation.role, invitation.id, invitation.invited_by],
        },
        guard,
        now,
      }),
      this.database
        .prepare(`
          insert into org_memberships (org_id, user_id, role, created_at, updated_at, revoked_at)
          select ?, ?, ?, ?, ?, null where ${guard.sql}
          on conflict (org_id, user_id) do update set
            role = excluded.role, created_at = excluded.created_at, updated_at = excluded.updated_at, revoked_at = null
        `)
        .bind(invitation.org_id, who.userId, invitation.role, now, now, ...guard.bind),
      this.database
        .prepare(`
          update org_invitations set accepted_at = ?
          where id = ? and accepted_at is null and revoked_at is null and expires_at > ?
            and changes() = 1
        `)
        .bind(now, invitation.id, now),
    ])
    if (membership!.meta.changes !== 1 || accepted!.meta.changes !== 1) throw new D1AccessAuthorityError("org_invitation_invalid")
    return { user_id: who.userId, public_id: who.userId, role: invitation.role, joined_at: now }
  }

  /** Changes only a membership that is still active when the batch runs. */
  private async setRole(who: AccessPrincipal, orgId: string, userId: string, role: OrgMemberRole) {
    await this.assertOwnershipChange(who, orgId, await this.membership(orgId, userId), role)
    const now = this.context.now()
    const guard = this.changeGuard(who, orgId, userId, role, true)
    const write = this.database
      .prepare(`
        update org_memberships set role = ?, updated_at = ?
        where org_id = ? and user_id = ? and revoked_at is null and ${guard.sql}
      `)
      .bind(role, now, orgId, userId, ...guard.bind)
    await this.database.batch([
      accessAuditStatement(this.context, {
        who,
        action: "org.member.role_changed",
        metadata: this.roleChange(orgId, userId, role),
        guard,
        now,
      }),
      write,
    ])
    const member = await this.database
      .prepare(`
        select user_id, user_id as public_id, role, created_at as joined_at
        from org_memberships where org_id = ? and user_id = ? and revoked_at is null
      `)
      .bind(orgId, userId)
      .first<OrgMember>()
    if (!member || member.role !== role) {
      throw new D1AccessAuthorityError("resource_conflict", "Organization membership changed concurrently")
    }
    return member
  }

  private async adminOrganization(who: AccessPrincipal, value: string) {
    const orgId = requireText(value, "orgId")
    this.context.assertOrganizationAllowed(orgId)
    if (!(await may(this.database, who, "administer", { kind: "org", orgId }))) {
      throw new D1AccessAuthorityError("org_admin_required")
    }
    return orgId
  }

  private async membership(orgId: string, userId: string): Promise<MembershipState> {
    const row = await this.database
      .prepare(`
        select org.owner_user_id = ? as founder, member.role
        from orgs org
        left join org_memberships member
          on member.org_id = org.org_id and member.user_id = ? and member.revoked_at is null
        where org.org_id = ? and org.deleted_at is null
      `)
      .bind(userId, userId, orgId)
      .first<{ founder: number; role: OrgMemberRole | null }>()
    return { founder: row?.founder === 1, role: row?.role ?? null }
  }

  private async assertOwnershipChange(
    who: AccessPrincipal,
    orgId: string,
    current: MembershipState,
    next: OrgMemberRole | null,
  ) {
    if (current.founder && next !== "owner") throw new D1AccessAuthorityError("org_owner_protected")
    if (current.role !== "owner" && next !== "owner") return
    if (!(await may(this.database, who, "own", { kind: "org", orgId }))) throw new D1AccessAuthorityError("org_owner_required")
  }

  /**
   * The checks `assertOwnershipChange` and `adminOrganization` made, re-read
   * inside the batch so a concurrent change between the read and the write
   * cannot slip past them: the caller still administers the organization, the
   * target is an active user, the founder keeps the owner role, whoever moves
   * an owner role is an owner, and a change to a membership (an update or a
   * removal) still finds it active. Setting a role also requires that the
   * active membership does not already hold it, so a change with nothing to
   * change writes nothing, its audit row included.
   */
  private changeGuard(
    who: AccessPrincipal,
    orgId: string,
    userId: string,
    next: OrgMemberRole | null,
    requireActiveMembership = next === null,
  ): BoundSql {
    const administers = maySql(who, "administer", { kind: "org", orgId: "guard_org.org_id" })
    const owns = maySql(who, "own", { kind: "org", orgId: "guard_org.org_id" })
    const targetIsOwner = `exists (
      select 1 from org_memberships target_row
      where target_row.org_id = guard_org.org_id and target_row.user_id = guard_target.user_id
        and target_row.role = 'owner' and target_row.revoked_at is null
    )`
    return {
      sql: `exists (
        select 1 from orgs guard_org
        join users guard_target on guard_target.user_id = ?${next === null ? "" : " and guard_target.state = 'active'"}
        where guard_org.org_id = ? and guard_org.deleted_at is null
          and ${administers.sql}
          and (guard_org.owner_user_id <> guard_target.user_id or ? = 'owner')
          and (${owns.sql} or (coalesce(?, '') <> 'owner' and not ${targetIsOwner}))
          ${requireActiveMembership ? `and exists (
            select 1 from org_memberships active_row
            where active_row.org_id = guard_org.org_id and active_row.user_id = guard_target.user_id
              and active_row.revoked_at is null
          )` : ""}
          ${next === null ? "" : `and not exists (
            select 1 from org_memberships unchanged_row
            where unchanged_row.org_id = guard_org.org_id and unchanged_row.user_id = guard_target.user_id
              and unchanged_row.revoked_at is null and unchanged_row.role = ?
          )`}
      )`,
      bind: [userId, orgId, ...administers.bind, next, ...owns.bind, next, ...(next === null ? [] : [next])],
    }
  }

  private roleChange(orgId: string, userId: string, after: OrgMemberRole | null): BoundSql {
    return {
      sql: `json_object('orgId', ?, 'targetUserId', ?,
        'before', (select role from org_memberships where org_id = ? and user_id = ? and revoked_at is null),
        'after', ?)`,
      bind: [orgId, userId, orgId, userId, after],
    }
  }
}
