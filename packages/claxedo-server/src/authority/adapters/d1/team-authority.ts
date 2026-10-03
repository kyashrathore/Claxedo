import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  accessAuditStatement,
  D1AccessAuthorityError,
  requireText,
  resolveTeamMemberUser,
  type AccessPrincipal,
  type D1AccessContext,
} from "./access-context"
import type {
  TeamMemberSelector,
  OrgMemberRole,
  ProjectGrantRole,
} from "@claxedo/server-core/platform/auth/org-access-authority"
import { may, mayGuard, maySql, type BoundSql } from "./authorization"

export const D1_TEAM_AUTHORITY_METHODS = [
  "listTeams",
  "createTeamInOrg",
  "ensureDefaultTeam",
  "addTeamMember",
  "removeTeamMember",
  "listTeamMembers",
  "grantTeamProject",
  "revokeTeamProject",
  "listTeamProjects",
] as const satisfies readonly (keyof WorkspaceAuthority)[]

export type D1TeamAuthorityPort = Pick<WorkspaceAuthority, (typeof D1_TEAM_AUTHORITY_METHODS)[number]>

export class D1TeamAuthority implements D1TeamAuthorityPort {
  constructor(private readonly context: D1AccessContext) {}

  private get database() {
    return this.context.database
  }

  async listTeams(auth: SignedControlPlaneAuth, args: { orgId: string }) {
    const who = await this.context.principal(auth)
    const orgId = requireText(args.orgId, "orgId")
    if (!(await may(this.database, who, "member", { kind: "org", orgId }))) return []
    const result = await this.database
      .prepare(`
        select team_id, org_id, name, is_default
        from teams
        where org_id = ? and deleted_at is null
        order by name, team_id
      `)
      .bind(orgId)
      .all<{ team_id: string; org_id: string; name: string; is_default: number }>()
    return result.results.map((row) => ({ ...row, is_default: row.is_default === 1 }))
  }

  async createTeamInOrg(auth: SignedControlPlaneAuth, args: { orgId: string; name: string }) {
    const who = await this.context.principal(auth)
    const orgId = requireText(args.orgId, "orgId")
    const name = requireText(args.name, "name")
    this.context.assertOrganizationAllowed(orgId)
    if (!(await may(this.database, who, "administer", { kind: "org", orgId }))) {
      throw new D1AccessAuthorityError("org_admin_required")
    }
    const org = await this.database
      .prepare(`select kind from orgs where org_id = ? and deleted_at is null`)
      .bind(orgId)
      .first<{ kind: "personal" | "team" | "deployment" }>()
    if (!org) throw new D1AccessAuthorityError("org_admin_required")
    if (org.kind === "personal") throw new D1AccessAuthorityError("team_not_allowed_on_personal_org")
    const teamId = this.context.randomId("team")
    const now = this.context.now()
    const guard = mayGuard(who, "administer", { kind: "org", orgId })
    await this.database.batch([
      accessAuditStatement(this.context, {
        who,
        action: "team.created",
        metadata: { sql: `json_object('orgId', ?, 'teamId', ?, 'targetUserId', ?, 'before', null, 'after', 'owner')`, bind: [orgId, teamId, who.userId] },
        guard,
        now,
      }),
      this.database
        .prepare(`
          insert into teams (team_id, org_id, name, is_default, created_by_user_id, created_at, updated_at, deleted_at)
          select ?, ?, ?, 0, ?, ?, ?, null where ${guard.sql}
          on conflict (team_id) do nothing
        `)
        .bind(teamId, orgId, name, who.userId, now, now, ...guard.bind),
      this.database
        .prepare(`
          insert into team_memberships (team_id, user_id, role, created_at, updated_at, revoked_at)
          select t.team_id, ?, 'owner', ?, ?, null
          from teams t where t.team_id = ? and t.org_id = ? and t.deleted_at is null
          on conflict (team_id, user_id) do update set
            role = 'owner', updated_at = excluded.updated_at, revoked_at = null
        `)
        .bind(who.userId, now, now, teamId, orgId),
    ])
    const created = await this.database
      .prepare(`select team_id from teams where team_id = ? and org_id = ? and deleted_at is null`)
      .bind(teamId, orgId)
      .first()
    if (!created) throw new D1AccessAuthorityError("resource_conflict", "Team creation authority changed")
    return { team_id: teamId, org_id: orgId, name, role: "owner" as const }
  }

  /**
   * Creates what the organization's default team is missing: the team, a
   * membership for each org member who never had one, and an editor grant on
   * each project it never had one on. A membership or grant that exists in
   * any state, including one an admin revoked or re-roled, is left as it is.
   */
  async ensureDefaultTeam(auth: SignedControlPlaneAuth, args: { orgId: string }) {
    const who = await this.context.principal(auth)
    const orgId = requireText(args.orgId, "orgId")
    this.context.assertOrganizationAllowed(orgId)
    if (!(await may(this.database, who, "administer", { kind: "org", orgId }))) {
      throw new D1AccessAuthorityError("org_admin_required")
    }
    const org = await this.database
      .prepare(`select name, kind from orgs where org_id = ? and deleted_at is null`)
      .bind(orgId)
      .first<{ name: string; kind: "personal" | "team" | "deployment" }>()
    if (!org) throw new D1AccessAuthorityError("org_admin_required")
    if (org.kind === "personal") return { skipped: true as const }
    const existing = await this.database
      .prepare(`select team_id from teams where org_id = ? and is_default = 1 and deleted_at is null`)
      .bind(orgId)
      .first<{ team_id: string }>()
    const teamId = existing?.team_id ?? this.context.randomId("team")
    const now = this.context.now()
    const guard = mayGuard(who, "administer", { kind: "org", orgId })
    const noDefaultTeam: BoundSql = {
      sql: `${guard.sql} and not exists (
        select 1 from teams current where current.org_id = ? and current.is_default = 1 and current.deleted_at is null
      )`,
      bind: [...guard.bind, orgId],
    }
    const missingMembers: BoundSql = {
      sql: `from org_memberships om
        join users u on u.user_id = om.user_id and u.state = 'active'
        join teams t on t.team_id = ? and t.org_id = om.org_id and t.deleted_at is null
        where om.org_id = ? and om.revoked_at is null
          and not exists (select 1 from team_memberships current where current.team_id = t.team_id and current.user_id = om.user_id)`,
      bind: [teamId, orgId],
    }
    const missingGrants: BoundSql = {
      sql: `from projects p
        join teams t on t.team_id = ? and t.org_id = p.org_id and t.deleted_at is null
        where p.org_id = ? and p.deleted_at is null
          and not exists (select 1 from team_project_grants current where current.team_id = t.team_id and current.project_id = p.project_id)`,
      bind: [teamId, orgId],
    }
    const memberRole = "case when om.role in ('owner', 'admin') then om.role else 'member' end"
    await this.database.batch([
      accessAuditStatement(this.context, {
        who,
        action: "team.created",
        metadata: { sql: `json_object('orgId', ?, 'teamId', ?)`, bind: [orgId, teamId] },
        guard: noDefaultTeam,
        now,
      }),
      this.database
        .prepare(`
          insert into teams (team_id, org_id, name, is_default, created_by_user_id, created_at, updated_at, deleted_at)
          select ?, ?, ?, 1, ?, ?, ?, null where ${noDefaultTeam.sql}
          on conflict (team_id) do nothing
        `)
        .bind(teamId, orgId, org.name || "Everyone", who.userId, now, now, ...noDefaultTeam.bind),
      accessAuditStatement(this.context, {
        who,
        action: "team.member.added",
        metadata: {
          sql: `json_object('orgId', ?, 'teamId', ?, 'targetUserId', om.user_id, 'before', null, 'after', ${memberRole})`,
          bind: [orgId, teamId],
        },
        rows: { ...missingMembers, key: "om.user_id" },
        guard,
        now,
      }),
      this.database
        .prepare(`
          insert into team_memberships (team_id, user_id, role, created_at, updated_at, revoked_at)
          select t.team_id, om.user_id, ${memberRole}, ?, ?, null
          ${missingMembers.sql} and ${guard.sql}
          on conflict (team_id, user_id) do nothing
        `)
        .bind(now, now, ...missingMembers.bind, ...guard.bind),
      accessAuditStatement(this.context, {
        who,
        action: "team.project.granted",
        metadata: {
          sql: `json_object('orgId', ?, 'teamId', ?, 'projectId', p.project_id, 'before', null, 'after', 'editor')`,
          bind: [orgId, teamId],
        },
        rows: { ...missingGrants, key: "p.project_id" },
        guard,
        now,
      }),
      this.database
        .prepare(`
          insert into team_project_grants (
            team_id, project_id, role, created_by_user_id, created_at, updated_at, revoked_at
          )
          select t.team_id, p.project_id, 'editor', ?, ?, ?, null
          ${missingGrants.sql} and ${guard.sql}
          on conflict (team_id, project_id) do nothing
        `)
        .bind(who.userId, now, now, ...missingGrants.bind, ...guard.bind),
    ])
    const selected = await this.database
      .prepare(`select team_id from teams where org_id = ? and is_default = 1 and deleted_at is null`)
      .bind(orgId)
      .first<{ team_id: string }>()
    if (!selected) throw new D1AccessAuthorityError("resource_conflict", "Default team creation raced")
    return { team_id: selected.team_id, org_id: orgId }
  }

  async addTeamMember(auth: SignedControlPlaneAuth, args: TeamMemberSelector & { teamId: string; role?: OrgMemberRole }) {
    const who = await this.context.principal(auth)
    const team = await this.adminTeam(who, args.teamId)
    const target = await resolveTeamMemberUser(this.context, args)
    if (!target || !(await may(this.database, { userId: target.user_id }, "member", { kind: "org", orgId: team.org_id }))) {
      throw new D1AccessAuthorityError("team_member_org_membership_required")
    }
    const role = args.role ?? "member"
    const now = this.context.now()
    const guard = this.teamAdminGuard(who, team.team_id, `
      and exists (
        select 1 from org_memberships target
        join users target_user on target_user.user_id = target.user_id and target_user.state = 'active'
        where target.org_id = guard_team.org_id and target.user_id = ? and target.revoked_at is null
      )
      and not exists (
        select 1 from team_memberships unchanged
        where unchanged.team_id = guard_team.team_id and unchanged.user_id = ?
          and unchanged.revoked_at is null and unchanged.role = ?
      )`, [target.user_id, target.user_id, role])
    await this.database.batch([
      accessAuditStatement(this.context, {
        who,
        action: "team.member.added",
        metadata: this.memberChange(team, target.user_id, role),
        guard,
        now,
      }),
      this.database
        .prepare(`
          insert into team_memberships (team_id, user_id, role, created_at, updated_at, revoked_at)
          select ?, ?, ?, ?, ?, null where ${guard.sql}
          on conflict (team_id, user_id) do update set
            role = excluded.role, updated_at = excluded.updated_at, revoked_at = null
        `)
        .bind(team.team_id, target.user_id, role, now, now, ...guard.bind),
    ])
    const active = await this.database
      .prepare(`select role from team_memberships where team_id = ? and user_id = ? and revoked_at is null`)
      .bind(team.team_id, target.user_id)
      .first<{ role: string }>()
    if (!active || active.role !== role) {
      throw new D1AccessAuthorityError("resource_conflict", "Team membership authority changed")
    }
    return { team_id: team.team_id, user_id: target.user_id, public_id: target.user_id, role }
  }

  async removeTeamMember(auth: SignedControlPlaneAuth, args: TeamMemberSelector & { teamId: string }) {
    const who = await this.context.principal(auth)
    const team = await this.adminTeam(who, args.teamId)
    const target = await resolveTeamMemberUser(this.context, args)
    if (!target) return { removed: false }
    const now = this.context.now()
    const guard = this.teamAdminGuard(who, team.team_id, `
      and exists (
        select 1 from team_memberships current
        where current.team_id = guard_team.team_id and current.user_id = ? and current.revoked_at is null
      )`, [target.user_id])
    const [, removed] = await this.database.batch([
      accessAuditStatement(this.context, {
        who,
        action: "team.member.removed",
        metadata: this.memberChange(team, target.user_id, null),
        guard,
        now,
      }),
      this.database
        .prepare(`
          update team_memberships set revoked_at = ?, updated_at = ?
          where team_id = ? and user_id = ? and revoked_at is null and ${guard.sql}
        `)
        .bind(now, now, team.team_id, target.user_id, ...guard.bind),
    ])
    return { removed: (removed.meta.changes ?? 0) > 0 }
  }

  async listTeamMembers(auth: SignedControlPlaneAuth, args: { teamId: string }) {
    const who = await this.context.principal(auth)
    const team = await this.team(requireText(args.teamId, "teamId"))
    if (!team || !(await may(this.database, who, "member", { kind: "org", orgId: team.org_id }))) return []
    const result = await this.database
      .prepare(`
        select tm.user_id, tm.user_id as public_id, tm.role,
          (select ai.issuer || '|' || ai.subject from auth_identities ai
            where ai.user_id = tm.user_id and ai.unlinked_at is null
            order by ai.linked_at, ai.adapter, ai.issuer, ai.subject limit 1) as token_identifier,
          (select ai.subject from auth_identities ai
            where ai.user_id = tm.user_id and ai.unlinked_at is null
            order by ai.linked_at, ai.adapter, ai.issuer, ai.subject limit 1) as provider_subject
        from team_memberships tm
        join users u on u.user_id = tm.user_id and u.state = 'active'
        join org_memberships om on om.user_id = tm.user_id and om.org_id = ? and om.revoked_at is null
        where tm.team_id = ? and tm.revoked_at is null
        order by case tm.role when 'owner' then 3 when 'admin' then 2 else 1 end desc, tm.user_id
      `)
      .bind(team.org_id, team.team_id)
      .all()
    return result.results
  }

  async grantTeamProject(auth: SignedControlPlaneAuth, args: { teamId: string; projectId: string; role: ProjectGrantRole }) {
    const who = await this.context.principal(auth)
    const team = await this.adminTeam(who, args.teamId)
    const projectId = requireText(args.projectId, "projectId")
    const project = await this.database
      .prepare(`select org_id from projects where project_id = ? and deleted_at is null`)
      .bind(projectId)
      .first<{ org_id: string }>()
    if (!project || project.org_id !== team.org_id) throw new D1AccessAuthorityError("project_not_found")
    const now = this.context.now()
    const guard = this.teamAdminGuard(who, team.team_id, `
      and exists (
        select 1 from projects project
        where project.project_id = ? and project.org_id = guard_team.org_id and project.deleted_at is null
      )
      and not exists (
        select 1 from team_project_grants unchanged
        where unchanged.team_id = guard_team.team_id and unchanged.project_id = ?
          and unchanged.revoked_at is null and unchanged.role = ?
      )`, [projectId, projectId, args.role])
    await this.database.batch([
      accessAuditStatement(this.context, {
        who,
        action: "team.project.granted",
        metadata: this.grantChange(team, projectId, args.role),
        guard,
        now,
      }),
      this.database
        .prepare(`
          insert into team_project_grants (
            team_id, project_id, role, created_by_user_id, created_at, updated_at, revoked_at
          )
          select ?, ?, ?, ?, ?, ?, null where ${guard.sql}
          on conflict (team_id, project_id) do update set
            role = excluded.role,
            created_by_user_id = excluded.created_by_user_id,
            updated_at = excluded.updated_at,
            revoked_at = null
        `)
        .bind(team.team_id, projectId, args.role, who.userId, now, now, ...guard.bind),
    ])
    const active = await this.database
      .prepare(`select role from team_project_grants where team_id = ? and project_id = ? and revoked_at is null`)
      .bind(team.team_id, projectId)
      .first<{ role: string }>()
    if (!active || active.role !== args.role) {
      throw new D1AccessAuthorityError("resource_conflict", "Team project authority changed")
    }
    return { team_id: team.team_id, project_id: projectId, role: args.role }
  }

  async revokeTeamProject(auth: SignedControlPlaneAuth, args: { teamId: string; projectId: string }) {
    const who = await this.context.principal(auth)
    const team = await this.adminTeam(who, args.teamId)
    const projectId = requireText(args.projectId, "projectId")
    const now = this.context.now()
    const guard = this.teamAdminGuard(who, team.team_id, `
      and exists (
        select 1 from team_project_grants current
        where current.team_id = guard_team.team_id and current.project_id = ? and current.revoked_at is null
      )`, [projectId])
    const [, revoked] = await this.database.batch([
      accessAuditStatement(this.context, {
        who,
        action: "team.project.revoked",
        metadata: this.grantChange(team, projectId, null),
        guard,
        now,
      }),
      this.database
        .prepare(`
          update team_project_grants set revoked_at = ?, updated_at = ?
          where team_id = ? and project_id = ? and revoked_at is null and ${guard.sql}
        `)
        .bind(now, now, team.team_id, projectId, ...guard.bind),
    ])
    return { revoked: (revoked.meta.changes ?? 0) > 0 }
  }

  /** The projects a team reaches and the role it holds on each; empty to a caller outside the team's organization. */
  async listTeamProjects(auth: SignedControlPlaneAuth, args: { teamId: string }) {
    const who = await this.context.principal(auth)
    const team = await this.team(requireText(args.teamId, "teamId"))
    if (!team || !(await may(this.database, who, "member", { kind: "org", orgId: team.org_id }))) return []
    const result = await this.database
      .prepare(`
        select grant_row.team_id, grant_row.project_id, grant_row.role, grant_row.updated_at
        from team_project_grants grant_row
        join projects project
          on project.project_id = grant_row.project_id and project.org_id = ? and project.deleted_at is null
        where grant_row.team_id = ? and grant_row.revoked_at is null
        order by grant_row.project_id
      `)
      .bind(team.org_id, team.team_id)
      .all<{ team_id: string; project_id: string; role: ProjectGrantRole; updated_at: number }>()
    return result.results
  }

  private async team(teamId: string) {
    return await this.database
      .prepare(`select team_id, org_id from teams where team_id = ? and deleted_at is null`)
      .bind(teamId)
      .first<{ team_id: string; org_id: string }>()
  }

  /** A live team of an organization the caller administers; any other team is answered as absent. */
  private async adminTeam(who: AccessPrincipal, teamId: string) {
    const team = await this.team(requireText(teamId, "teamId"))
    if (!team || !(await may(this.database, who, "administer", { kind: "org", orgId: team.org_id }))) {
      throw new D1AccessAuthorityError("team_not_found")
    }
    return team
  }

  /**
   * The team is live and the caller administers its organization, re-read
   * inside the batch that changes it, plus the change's own condition written
   * over `guard_team`.
   */
  private teamAdminGuard(who: AccessPrincipal, teamId: string, condition: string, bind: unknown[]): BoundSql {
    const administers = maySql(who, "administer", { kind: "org", orgId: "guard_team.org_id" })
    return {
      sql: `exists (
        select 1 from teams guard_team
        where guard_team.team_id = ? and guard_team.deleted_at is null
          and ${administers.sql}
          ${condition}
      )`,
      bind: [teamId, ...administers.bind, ...bind],
    }
  }

  private memberChange(team: { team_id: string; org_id: string }, userId: string, after: OrgMemberRole | null): BoundSql {
    return {
      sql: `json_object('orgId', ?, 'teamId', ?, 'targetUserId', ?,
        'before', (select role from team_memberships where team_id = ? and user_id = ? and revoked_at is null),
        'after', ?)`,
      bind: [team.org_id, team.team_id, userId, team.team_id, userId, after],
    }
  }

  private grantChange(team: { team_id: string; org_id: string }, projectId: string, after: ProjectGrantRole | null): BoundSql {
    return {
      sql: `json_object('orgId', ?, 'teamId', ?, 'projectId', ?,
        'before', (select role from team_project_grants where team_id = ? and project_id = ? and revoked_at is null),
        'after', ?)`,
      bind: [team.org_id, team.team_id, projectId, team.team_id, projectId, after],
    }
  }
}
