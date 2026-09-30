import type { ProjectAction, ProjectRole } from "@claxedo/server-core/platform/auth/authority"

export function roleRankSql(column: string) {
  return `case ${column} when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 else 0 end`
}

/**
 * A person's rank on a project: the highest of being its owner (4), their own
 * member grant, the best grant of a team they are on in the project's
 * organization, and `orgRoleRankSql`. Every project decision on D1 reads its
 * rank from here. A workspace surface reads `workspaceRoleRankSql` instead.
 *
 * `orgMemberVisible` selects the form the session layer still reads as a
 * workspace rank (`actorWorkspaceRoleRankSql` in `session-access-sql.ts`):
 * `ownerUserId` is then the workspace's owner, the member and team grants
 * count only where the workspace's `org_member_visible` is 1, and a member
 * grant is worth at most admin (3).
 *
 * Each input is a SQL expression in the caller's row scope and is repeated
 * verbatim, so a `?` inside one is bound once per occurrence.
 *
 * Organization membership itself is not checked here; callers gate on
 * `activeOrgMemberSql` so a person outside the organization gets no row.
 */
export function projectRoleRankSql(input: {
  user: string
  projectId: string
  orgId: string
  ownerUserId: string
  orgMemberVisible?: string
}) {
  const { user, projectId, orgId, orgMemberVisible } = input
  const memberRank = orgMemberVisible ? `min(${roleRankSql("rank_member.role")}, 3)` : roleRankSql("rank_member.role")
  const grant = (rank: string) => (orgMemberVisible ? `case when ${orgMemberVisible} = 1 then ${rank} else 0 end` : rank)
  return `max(
    case when ${input.ownerUserId} = ${user} then 4 else 0 end,
    ${grant(`coalesce((
      select ${memberRank} from project_memberships rank_member
      where rank_member.project_id = ${projectId} and rank_member.user_id = ${user} and rank_member.revoked_at is null
    ), 0)`)},
    ${grant(`coalesce((
      select max(${roleRankSql("rank_team_grant.role")}) from team_project_grants rank_team_grant
      join team_memberships rank_team_member
        on rank_team_member.team_id = rank_team_grant.team_id and rank_team_member.user_id = ${user}
        and rank_team_member.revoked_at is null
      join teams rank_team
        on rank_team.team_id = rank_team_grant.team_id and rank_team.org_id = ${orgId} and rank_team.deleted_at is null
      where rank_team_grant.project_id = ${projectId} and rank_team_grant.revoked_at is null
    ), 0)`)},
    ${orgRoleRankSql({ user, orgId, ...(orgMemberVisible ? { orgMemberVisible } : {}) })}
  )`
}

/**
 * What a person's organization role alone is worth on its projects: owners
 * and admins 3, members 1, anyone else 0. `orgMemberVisible` is a
 * workspace's `org_member_visible`: an ordinary member's rank applies only
 * where it is 1. A project has no such column; every member of its
 * organization may see it.
 */
export function orgRoleRankSql(input: { user: string; orgId: string; orgMemberVisible?: string }) {
  const ordinaryMember = input.orgMemberVisible
    ? `rank_org_member.role = 'member' and ${input.orgMemberVisible} = 1`
    : `rank_org_member.role = 'member'`
  return `coalesce((
      select case when rank_org.owner_user_id = ${input.user} then 3
        when rank_org_member.role in ('owner', 'admin') then 3
        when ${ordinaryMember} then 1 else 0 end
      from orgs rank_org
      left join org_memberships rank_org_member
        on rank_org_member.org_id = rank_org.org_id and rank_org_member.user_id = ${input.user}
        and rank_org_member.revoked_at is null
      where rank_org.org_id = ${input.orgId} and rank_org.deleted_at is null
    ), 0)`
}

/**
 * A person's rank on a workspace: 4 for its owner, 0 for everyone else. A
 * workspace is a folder on its owner's machine; no organization role,
 * project role, or project or team grant reaches it. Callers still gate on
 * `activeOrgMemberSql`, so an owner outside the workspace's organization gets
 * no row.
 */
export function workspaceRoleRankSql(input: { user: string; ownerUserId: string }) {
  return `case when ${input.ownerUserId} = ${input.user} then 4 else 0 end`
}

export function activeOrgMemberSql(orgExpression: string, userExpression: string) {
  return `exists (
    select 1 from orgs member_org
    left join org_memberships member_row
      on member_row.org_id = member_org.org_id and member_row.user_id = ${userExpression} and member_row.revoked_at is null
    where member_org.org_id = ${orgExpression} and member_org.deleted_at is null
      and (member_org.owner_user_id = ${userExpression} or member_row.user_id is not null)
  )`
}

export function organizationAdminSql(orgExpression: string, userExpression: string) {
  return `exists (
    select 1 from orgs admin_org
    left join org_memberships admin_row
      on admin_row.org_id = admin_org.org_id and admin_row.user_id = ${userExpression} and admin_row.revoked_at is null
    where admin_org.org_id = ${orgExpression} and admin_org.deleted_at is null
      and (admin_org.owner_user_id = ${userExpression} or admin_row.role in ('owner', 'admin'))
  )`
}

export function roleRank(role: ProjectRole) {
  return role === "viewer" ? 1 : role === "editor" ? 2 : role === "admin" ? 3 : 4
}

export function actionRank(action: ProjectAction) {
  return action === "read" ? 1 : action === "write" ? 2 : action === "admin" ? 3 : 4
}

export function rankRole(rank: number): ProjectRole {
  return rank >= 4 ? "owner" : rank >= 3 ? "admin" : rank >= 2 ? "editor" : "viewer"
}

/**
 * The project with its organization and the user's `role_rank`, when the user
 * belongs to that organization. Binds the user id, the project id, then the
 * organization id the project must be in, or null for any.
 */
export const PROJECT_ACCESS_SQL = `
  with me as (select ? as user_id)
  select p.org_id, ${projectRoleRankSql({
    user: "me.user_id",
    projectId: "p.project_id",
    orgId: "p.org_id",
    ownerUserId: "p.owner_user_id",
  })} as role_rank
  from me
  join projects p on p.project_id = ? and p.deleted_at is null and p.org_id = coalesce(?, p.org_id)
  where ${activeOrgMemberSql("p.org_id", "me.user_id")}
`

/**
 * Every workspace row matching `predicate` (written over `w`) in an
 * organization the user belongs to, with the user's `role_rank` on it; a rank
 * of 0 is still a row. Binds the user id, then the predicate's own values.
 */
export function workspaceAccessSql(predicate: string, extension: { columns?: string; joins?: string } = {}) {
  return `
    with me as (select ? as user_id)
    select w.*, ${workspaceRoleRankSql({ user: "me.user_id", ownerUserId: "w.owner_user_id" })} as role_rank${extension.columns ? `, ${extension.columns}` : ""}
    from me
    join workspaces w on ${predicate}
    join projects p on p.project_id = w.project_id and p.org_id = w.org_id and p.deleted_at is null
    ${extension.joins ?? ""}
    where ${activeOrgMemberSql("w.org_id", "me.user_id")}
    order by w.created_at, w.workspace_id
  `
}
