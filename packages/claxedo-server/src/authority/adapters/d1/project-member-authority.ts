import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  isProjectGrantRole,
  type ProjectAccessEntry,
  type ProjectAccessListing,
  type ProjectGrantRole,
} from "@claxedo/server-core/platform/auth/org-access-authority"
import {
  accessAuditStatement,
  D1AccessAuthorityError,
  isActiveOrgMember,
  requireText,
  revokeRuntimeTokensStatement,
  type AccessPrincipal,
  type BoundSql,
  type D1AccessContext,
} from "./access-context"
import { activeOrgMemberSql, orgRoleRankSql, PROJECT_ACCESS_SQL, projectRoleRankSql, rankRole, roleRankSql } from "./project-role"

export const D1_PROJECT_MEMBER_AUTHORITY_METHODS = [
  "grantProjectMember",
  "revokeProjectMember",
  "listProjectAccess",
] as const satisfies readonly (keyof WorkspaceAuthority)[]

export type D1ProjectMemberAuthorityPort = Pick<WorkspaceAuthority, (typeof D1_PROJECT_MEMBER_AUTHORITY_METHODS)[number]>

type Project = { project_id: string; org_id: string; owner_user_id: string }

type AccessRow = {
  kind: "user" | "team"
  user_id: string | null
  team_id: string | null
  name: string | null
  role: string | number
  source: string
}

/**
 * Per-person project grants (`project_memberships`) and the listing of
 * everyone who reaches a project. A project admin, which includes every
 * organization owner and admin, grants and revokes; the owner's row is the
 * project's own and never changes here.
 */
export class D1ProjectMemberAuthority implements D1ProjectMemberAuthorityPort {
  constructor(private readonly context: D1AccessContext) {}

  private get database() {
    return this.context.database
  }

  async grantProjectMember(
    auth: SignedControlPlaneAuth,
    args: { projectId: string; userPublicId: string; role: ProjectGrantRole },
  ) {
    const who = await this.context.principal(auth)
    const project = await this.adminProject(who, args.projectId)
    const userId = requireText(args.userPublicId, "userPublicId")
    if (userId === project.owner_user_id) throw new D1AccessAuthorityError("project_member_owner_immutable")
    const target = await this.database
      .prepare(`select user_id from users where user_id = ? and state = 'active'`)
      .bind(userId)
      .first<{ user_id: string }>()
    if (!target) throw new D1AccessAuthorityError("project_member_not_found")
    if (!(await isActiveOrgMember(this.database, userId, project.org_id))) {
      throw new D1AccessAuthorityError("project_member_org_membership_required")
    }
    const now = this.context.now()
    const guard = this.changeGuard(who, project.project_id, userId, "")
    await this.database.batch([
      accessAuditStatement(this.context, {
        who,
        action: "project.member.granted",
        metadata: this.grantChange(project, userId, args.role),
        guard,
        now,
      }),
      revokeRuntimeTokensStatement(this.context, {
        holders: { sql: "select ?", bind: [userId] },
        projects: {
          sql: `select project_id from project_memberships
            where project_id = ? and user_id = ? and revoked_at is null and ${roleRankSql("role")} > ${roleRankSql("?")}`,
          bind: [project.project_id, userId, args.role],
        },
        guard,
        now,
      }),
      this.database
        .prepare(`
          insert into project_memberships (project_id, user_id, role, created_at, updated_at, revoked_at)
          select ?, ?, ?, ?, ?, null where ${guard.sql}
          on conflict (project_id, user_id) do update set
            role = excluded.role, updated_at = excluded.updated_at, revoked_at = null
        `)
        .bind(project.project_id, userId, args.role, now, now, ...guard.bind),
    ])
    const active = await this.database
      .prepare(`select role from project_memberships where project_id = ? and user_id = ? and revoked_at is null`)
      .bind(project.project_id, userId)
      .first<{ role: string }>()
    if (!active || active.role !== args.role) {
      throw new D1AccessAuthorityError("resource_conflict", "Project membership changed concurrently")
    }
    return { project_id: project.project_id, user_id: userId, role: args.role }
  }

  async revokeProjectMember(auth: SignedControlPlaneAuth, args: { projectId: string; userPublicId: string }) {
    const who = await this.context.principal(auth)
    const project = await this.adminProject(who, args.projectId)
    const userId = requireText(args.userPublicId, "userPublicId")
    if (userId === project.owner_user_id) throw new D1AccessAuthorityError("project_member_owner_immutable")
    const now = this.context.now()
    const guard = this.changeGuard(who, project.project_id, userId, `
      and exists (
        select 1 from project_memberships current
        where current.project_id = guard_project.project_id and current.user_id = guard_target.user_id
          and current.revoked_at is null
      )`)
    const [, , revoked] = await this.database.batch([
      accessAuditStatement(this.context, {
        who,
        action: "project.member.revoked",
        metadata: this.grantChange(project, userId, null),
        guard,
        now,
      }),
      revokeRuntimeTokensStatement(this.context, {
        holders: { sql: "select ?", bind: [userId] },
        projects: { sql: "select ?", bind: [project.project_id] },
        guard,
        now,
      }),
      this.database
        .prepare(`
          update project_memberships set revoked_at = ?, updated_at = ?
          where project_id = ? and user_id = ? and revoked_at is null and ${guard.sql}
        `)
        .bind(now, now, project.project_id, userId, ...guard.bind),
    ])
    return { revoked: (revoked.meta.changes ?? 0) > 0 }
  }

  /**
   * Everyone who reaches the project, one entry per source: its owner, each
   * member grant, each team grant (as the team), and each organization member
   * through their organization role. A person may appear under several
   * sources; their role on the project is the highest of them.
   */
  async listProjectAccess(auth: SignedControlPlaneAuth, args: { projectId: string }): Promise<ProjectAccessListing> {
    const who = await this.context.principal(auth)
    const project = await this.adminProject(who, args.projectId)
    const result = await this.database
      .prepare(`
        select 'user' as kind, project.owner_user_id as user_id, null as team_id, null as name,
          'owner' as role, 'owner' as source
        from projects project
        join users person on person.user_id = project.owner_user_id and person.state = 'active'
        where project.project_id = ?1 and ${activeOrgMemberSql("project.org_id", "project.owner_user_id")}
        union all
        select 'user', member.user_id, null, null, member.role, 'member'
        from project_memberships member
        join users person on person.user_id = member.user_id and person.state = 'active'
        where member.project_id = ?1 and member.revoked_at is null and member.role <> 'owner'
          and ${activeOrgMemberSql("?2", "member.user_id")}
        union all
        select 'team', null, team.team_id, team.name, team_grant.role, 'team:' || team.team_id
        from team_project_grants team_grant
        join teams team on team.team_id = team_grant.team_id and team.org_id = ?2 and team.deleted_at is null
        where team_grant.project_id = ?1 and team_grant.revoked_at is null
        union all
        select 'user', member.user_id, null, null,
          ${orgRoleRankSql({ user: "member.user_id", orgId: "?2" })}, 'org-role'
        from org_memberships member
        join users person on person.user_id = member.user_id and person.state = 'active'
        where member.org_id = ?2 and member.revoked_at is null
        order by kind desc, source, user_id, team_id
      `)
      .bind(project.project_id, project.org_id)
      .all<AccessRow>()
    return { project_id: project.project_id, org_id: project.org_id, entries: result.results.map(accessEntry) }
  }

  /** The live project, when the caller holds admin rank on it: organization owners and admins, and project admins. */
  private async adminProject(who: AccessPrincipal, value: string): Promise<Project> {
    const projectId = requireText(value, "projectId")
    const access = await this.database
      .prepare(PROJECT_ACCESS_SQL)
      .bind(who.userId, projectId, null)
      .first<{ org_id: string; role_rank: number }>()
    if (!access || access.role_rank < 1) throw new D1AccessAuthorityError("project_not_found")
    this.context.assertOrganizationAllowed(access.org_id)
    if (access.role_rank < 3) throw new D1AccessAuthorityError("project_admin_required")
    const project = await this.database
      .prepare(`select project_id, org_id, owner_user_id from projects where project_id = ? and deleted_at is null`)
      .bind(projectId)
      .first<Project>()
    if (!project) throw new D1AccessAuthorityError("project_not_found")
    return project
  }

  /**
   * Re-read inside the batch: the project is live, the caller still holds
   * admin rank on it, and the target is an active member of its organization
   * who is not its owner, plus the change's own condition.
   */
  private changeGuard(who: AccessPrincipal, projectId: string, userId: string, condition: string): BoundSql {
    return {
      sql: `exists (
        select 1 from projects guard_project
        join (select ? as user_id) guard_caller
        join users guard_target on guard_target.user_id = ? and guard_target.state = 'active'
        where guard_project.project_id = ? and guard_project.deleted_at is null
          and guard_project.owner_user_id <> guard_target.user_id
          and ${activeOrgMemberSql("guard_project.org_id", "guard_caller.user_id")}
          and ${activeOrgMemberSql("guard_project.org_id", "guard_target.user_id")}
          and ${projectRoleRankSql({
            user: "guard_caller.user_id",
            projectId: "guard_project.project_id",
            orgId: "guard_project.org_id",
            ownerUserId: "guard_project.owner_user_id",
          })} >= 3
          ${condition}
      )`,
      bind: [who.userId, userId, projectId],
    }
  }

  private grantChange(project: Project, userId: string, after: ProjectGrantRole | null): BoundSql {
    return {
      sql: `json_object('orgId', ?, 'projectId', ?, 'targetUserId', ?,
        'before', (select role from project_memberships where project_id = ? and user_id = ? and revoked_at is null),
        'after', ?)`,
      bind: [project.org_id, project.project_id, userId, project.project_id, userId, after],
    }
  }
}

function accessEntry(row: AccessRow): ProjectAccessEntry {
  if (row.kind === "team" && row.team_id && row.name && isProjectGrantRole(row.role)) {
    return { kind: "team", team_id: row.team_id, name: row.name, role: row.role, source: `team:${row.team_id}` }
  }
  if (row.kind === "user" && row.user_id) {
    if (row.source === "owner") return { kind: "user", user_id: row.user_id, role: "owner", source: "owner" }
    if (row.source === "member" && isProjectGrantRole(row.role)) {
      return { kind: "user", user_id: row.user_id, role: row.role, source: "member" }
    }
    if (row.source === "org-role" && typeof row.role === "number") {
      return { kind: "user", user_id: row.user_id, role: rankRole(row.role), source: "org-role" }
    }
  }
  throw new Error("D1 returned an invalid project access row")
}
