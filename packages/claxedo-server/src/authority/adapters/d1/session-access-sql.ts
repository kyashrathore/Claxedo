import type { SessionAccessQuestion } from "@claxedo/server-core/platform/auth/private-session-authority"
import { projectRoleRankSql } from "./project-role"

export function actorWorkspaceRoleRankSql(actorExpression: string, workspaceAlias: string) {
  return projectRoleRankSql({
    user: `(select user_id from actors where actor_id = ${actorExpression})`,
    projectId: `${workspaceAlias}.project_id`,
    orgId: `${workspaceAlias}.org_id`,
    ownerUserId: `${workspaceAlias}.owner_user_id`,
    orgMemberVisible: `${workspaceAlias}.org_member_visible`,
  })
}

export function actorWorkspaceAccessSql(actorExpression: string, workspaceAlias: string, rank: 1 | 2) {
  return `exists (
    select 1 from actors aa join users au on au.user_id = aa.user_id and au.state = 'active'
    where aa.actor_id = ${actorExpression} and aa.state = 'active'
      and exists (
        select 1 from orgs ao
        left join org_memberships aom
          on aom.org_id = ao.org_id and aom.user_id = au.user_id and aom.revoked_at is null
        where ao.org_id = ${workspaceAlias}.org_id and ao.deleted_at is null
          and (ao.owner_user_id = au.user_id or aom.user_id is not null)
      )
      and exists (
        select 1 from projects ap
        where ap.project_id = ${workspaceAlias}.project_id
          and ap.org_id = ${workspaceAlias}.org_id
          and ap.deleted_at is null
      )
      and ${actorWorkspaceRoleRankSql(actorExpression, workspaceAlias)} >= ${rank}
  )`
}

/**
 * Creator, participant and share grantee are the whole admission, asked of
 * someone who still stands in the session's organization; the project and the
 * workspace decide nothing, and a rank in the organization decides only who may
 * be OFFERED a share. The question narrows what a SHARE may answer: `follow`
 * reads, `send` also drives the agent's turn, and a `session_control` write
 * drops the share branch entirely, leaving the creator and the participants.
 */
export function actorSessionAccessSql(actorExpression: string, sessionAlias: string, access: SessionAccessQuestion) {
  const shareLevelSql = access === "agent_turn" ? "and share.level = 'send'" : ""
  return `${actorOrganizationStandingSql(actorExpression, sessionAlias)} and exists (
    select 1 from workspaces session_workspace
    where session_workspace.workspace_id = ${sessionAlias}.workspace_id
      and session_workspace.org_id = ${sessionAlias}.org_id
      and session_workspace.project_id = ${sessionAlias}.project_id
      and session_workspace.deleted_at is null
  ) and (
    ${sessionCreatedByActorUserSql(actorExpression, sessionAlias)}
    or exists (
      select 1 from session_participants sap
      where sap.session_id = ${sessionAlias}.session_id and sap.actor_id = ${actorExpression} and sap.revoked_at is null
    )
    ${access === "session_control" ? "" : `or exists (
      select 1 from session_share_grants share
      join actors share_actor on share_actor.actor_id = ${actorExpression}
        and share_actor.kind = 'human' and share_actor.state = 'active'
      join users share_user on share_user.user_id = share_actor.user_id and share_user.state = 'active'
      where share.session_id = ${sessionAlias}.session_id and share.revoked_at is null
        ${shareLevelSql}
        and (
          share.target_user_id = share_user.user_id
          or (
            share.target_org_id = ${sessionAlias}.org_id
            and exists (
              select 1 from org_memberships share_org_member
              where share_org_member.org_id = share.target_org_id
                and share_org_member.user_id = share_user.user_id
                and share_org_member.revoked_at is null
            )
          )
          or exists (
            select 1 from team_memberships share_team_member
            join teams share_team on share_team.team_id = share_team_member.team_id
              and share_team.org_id = ${sessionAlias}.org_id and share_team.deleted_at is null
            join org_memberships share_team_org_member
              on share_team_org_member.org_id = share_team.org_id
              and share_team_org_member.user_id = share_team_member.user_id
              and share_team_org_member.revoked_at is null
            where share_team_member.team_id = share.target_team_id
              and share_team_member.user_id = share_user.user_id
              and share_team_member.revoked_at is null
          )
        )
    )`}
  )`
}

/**
 * The standing every session decision needs before any of them: a live account
 * that is still in the organization the session belongs to. Leaving the
 * organization ends every grant inside it, creator standing included, so
 * membership is necessary here and never sufficient — nothing below reads a
 * rank.
 */
function actorOrganizationStandingSql(actorExpression: string, sessionAlias: string) {
  return `exists (
    select 1 from actors admitted_actor
    join users admitted_user
      on admitted_user.user_id = admitted_actor.user_id and admitted_user.state = 'active'
    where admitted_actor.actor_id = ${actorExpression} and admitted_actor.state = 'active'
      and ${userInOrganizationSql("admitted_actor.user_id", `${sessionAlias}.org_id`)}
  )`
}

/**
 * Who a session's people are is the creator's to decide, and nobody else's,
 * for as long as the creator stands in the organization.
 */
export function sessionCreatorSql(actorExpression: string, sessionAlias: string) {
  return `(${actorOrganizationStandingSql(actorExpression, sessionAlias)}
    and ${sessionCreatedByActorUserSql(actorExpression, sessionAlias)})`
}

/**
 * One person acts through several actors — the browser actor they sign in as
 * and the agent actor a runtime mints to drive a session unprompted — so
 * creator standing is a question about the user behind the actor. Comparing
 * actor ids would strand every session an agent opened on its owner's behalf.
 */
function sessionCreatedByActorUserSql(actorExpression: string, sessionAlias: string) {
  return `exists (
    select 1 from actors creator_actor
    join actors reading_actor
      on reading_actor.actor_id = ${actorExpression} and reading_actor.state = 'active'
    where creator_actor.actor_id = ${sessionAlias}.creator_actor_id
      and creator_actor.user_id = reading_actor.user_id
  )`
}

/**
 * Being in the organization is what makes a person offerable as a share
 * recipient. It carries no standing on the session, the workspace or the
 * machine; only the grant they are then given does.
 */
export function userInOrganizationSql(userExpression: string, orgExpression: string) {
  return `exists (
    select 1 from orgs offer_org
    left join org_memberships offer_member
      on offer_member.org_id = offer_org.org_id and offer_member.user_id = ${userExpression}
      and offer_member.revoked_at is null
    where offer_org.org_id = ${orgExpression} and offer_org.deleted_at is null
      and (offer_org.owner_user_id = ${userExpression} or offer_member.user_id is not null)
  )`
}

/**
 * Every `?` a fragment carries is the actor expression, so its own text says
 * how many copies of the actor id the caller must bind ahead of it.
 */
function actorBindings(fragment: string) {
  return fragment.match(/\?/g)?.length ?? 0
}

export const SESSION_ACCESS_BINDINGS: Record<SessionAccessQuestion, number> = {
  read: actorBindings(actorSessionAccessSql("?", "s", "read")),
  agent_turn: actorBindings(actorSessionAccessSql("?", "s", "agent_turn")),
  session_control: actorBindings(actorSessionAccessSql("?", "s", "session_control")),
}
export const SESSION_CREATOR_BINDINGS = actorBindings(sessionCreatorSql("?", "s"))
export const WORKSPACE_ACCESS_BINDINGS = actorBindings(actorWorkspaceAccessSql("?", "w", 1))
export const ORGANIZATION_STANDING_BINDINGS = actorBindings(userInOrganizationSql("?", "w.org_id"))
export const WORKSPACE_ROLE_RANK_BINDINGS = actorBindings(actorWorkspaceRoleRankSql("?", "w"))
