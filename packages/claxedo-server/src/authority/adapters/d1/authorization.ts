import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types"
import type { SessionRef } from "@claxedo/agent-runtime-contract"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import type { ProjectAction, ProjectRole } from "@claxedo/server-core/platform/auth/authority"

/**
 * Who may do what on D1. Every D1 authority class asks `may`, or composes
 * `maySql` into its own read or into a write's guard so the batch re-reads the
 * rule it was admitted under; no class keeps a rule of its own.
 *
 * - A workspace is a folder on its owner's machine: every workspace action is
 *   its owner's (`workspaces.owner_user_id`) and nobody else's.
 * - A session's actions are its workspace owner's, and a session share
 *   holder's for exactly what the share's level carries on exactly that
 *   session: `follow` reads and streams it, `send` also drives its agent's
 *   turn. A share reaches neither the workspace, another session, nor the
 *   creation of one.
 * - A project's actions follow the person's project role: the highest of
 *   owning it, their member grant, their teams' grants and their organization
 *   role. A project role reaches no workspace and no session.
 * - An organization's actions follow the person's organization role.
 *
 * Every rule also asks that the person be active and stand in the resource's
 * organization, so leaving it ends everything inside it, ownership included.
 */
export type AuthorizationPrincipal = {
  userId: string
  /** The acting actor, required active and the user's own; a share admits only a human one. */
  actorId?: string
}

/**
 * `open` sees the workspace and where it runs; `operate` acts on the machine
 * serving it (runtime access tokens, channels, plugin reads, the session list
 * it publishes); `create_session` creates or forks a session there;
 * `assign_host` has a machine serve it, which revives a retired machine-placed
 * row; `administer` unassigns its machine or deletes it.
 */
export type WorkspaceAction = "open" | "operate" | "create_session" | "assign_host" | "administer"

/** `read` includes the live stream; `send` is the agent's turn; `control` is every other session write. */
export type SessionAction = "read" | "send" | "control" | "manage_shares"

export type OrgAction = "member" | "administer" | "own"

type Rules = {
  workspace: { action: WorkspaceAction; ref: { workspaceId: string }; row: { alias: string } }
  session: { action: SessionAction; ref: SessionRef; row: { alias: string } }
  project: { action: ProjectAction; ref: { projectId: string; orgId?: string }; row: { alias: string } }
  org: { action: OrgAction; ref: { orgId: string }; row: { orgId: string } }
}

export type ResourceKind = keyof Rules

export type Resource<K extends ResourceKind = ResourceKind> = { [R in K]: { kind: R } & Rules[R]["ref"] }[K]

/** The resource as a row of the caller's query: a table alias, or the organization id as an SQL expression. */
export type ResourceRow<K extends ResourceKind = ResourceKind> = { [R in K]: { kind: R } & Rules[R]["row"] }[K]

export type ActionOn<K extends ResourceKind> = Rules[K]["action"]

export type BoundSql = { sql: string; bind: unknown[] }

export async function may<K extends ResourceKind>(
  database: D1Database,
  principal: AuthorizationPrincipal,
  action: ActionOn<K>,
  resource: Resource<K>,
): Promise<boolean> {
  const query = mayQuery(principal, action, resource as Resource)
  return !!(await database.prepare(query.sql).bind(...query.bind).first())
}

/**
 * `may` as a condition over a row of the caller's own query, for a read that
 * filters by it or a write that re-checks it inside its batch.
 */
export function maySql<K extends ResourceKind>(
  principal: AuthorizationPrincipal,
  action: ActionOn<K>,
  row: ResourceRow<K>,
): BoundSql {
  const withActor = principal.actorId !== undefined
  const resource = row as ResourceRow
  const rule = resource.kind === "workspace"
    ? workspaceRuleSql(action as WorkspaceAction, resource.alias)
    : resource.kind === "session"
      ? sessionRuleSql(action as SessionAction, resource.alias, withActor)
      : resource.kind === "project"
        ? projectRuleSql(action as ProjectAction, resource.alias)
        : orgRuleSql(action as OrgAction, resource.orgId)
  return bindPrincipal(`(${activePrincipalSql(withActor)} and ${rule})`, principal)
}

/** `may` as a condition a write's batch re-reads, for a resource named by its id. */
export function mayGuard<K extends ResourceKind>(
  principal: AuthorizationPrincipal,
  action: ActionOn<K>,
  resource: Resource<K>,
): BoundSql {
  const query = mayQuery(principal, action, resource as Resource)
  return { sql: `exists (${query.sql})`, bind: query.bind }
}

/** That the principal is still an active person with an active actor, for a write that names no resource. */
export function activeGuard(principal: AuthorizationPrincipal): BoundSql {
  return bindPrincipal(activePrincipalSql(principal.actorId !== undefined), principal)
}

/**
 * Runs a write whose authorization was read before it: `guard` is asked again
 * as the batch's first statement, so a suspension, a removal or a lost
 * resource between that read and this write refuses the whole batch. The
 * results are the caller's statements' own, in order; `run` is the caller's
 * own batch runner, which maps every other failure.
 */
export async function batchUnder(
  database: D1Database,
  guard: BoundSql,
  statements: D1PreparedStatement[],
  run: (statements: D1PreparedStatement[]) => Promise<D1Result[]> = (all) => database.batch(all),
): Promise<D1Result[]> {
  const id = assertionId()
  try {
    return (await run([
      database
        .prepare(`insert into authority_batch_assertions (assertion_id, passed) values (?, case when ${guard.sql} then 1 else 0 end)`)
        .bind(id, ...guard.bind),
      deleteAssertion(database, id),
      ...statements,
    ])).slice(2)
  } catch (error) {
    const holds = await database.prepare(`select ${guard.sql} as holds`).bind(...guard.bind).first<{ holds: number }>()
    if (holds?.holds === 1) throw error
    throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Authorization changed before the write")
  }
}

export function assertionId() {
  return `assert_${crypto.randomUUID()}`
}

/** Asserts the statement before it changed a row; a batch whose write landed on nothing aborts whole. */
export function wonAssertion(database: D1Database, id: string) {
  return database.prepare(`insert into authority_batch_assertions (assertion_id, passed) values (?, changes())`).bind(id)
}

export function deleteAssertion(database: D1Database, id: string) {
  return database.prepare(`delete from authority_batch_assertions where assertion_id = ?`).bind(id)
}

/** The person's role on a live project in an organization they stand in, or nothing. */
export async function readProjectRole(
  database: D1Database,
  userId: string,
  project: Resource<"project">,
): Promise<{ orgId: string; role: ProjectRole } | undefined> {
  const row = await database
    .prepare(`
      select p.org_id, ${projectRoleRankSql({ user: "?", projectId: "p.project_id", orgId: "p.org_id", ownerUserId: "p.owner_user_id" })} as role_rank
      from projects p
      where p.project_id = ? and p.deleted_at is null and p.org_id = coalesce(?, p.org_id)
        and ${orgMemberSql("p.org_id", "?")}
    `)
    .bind(...Array(PROJECT_RANK_USER_BINDINGS).fill(userId), project.projectId, project.orgId ?? null, userId, userId)
    .first<{ org_id: string; role_rank: number }>()
  return row && row.role_rank >= 1 ? { orgId: row.org_id, role: rankRole(row.role_rank) } : undefined
}

function mayQuery(principal: AuthorizationPrincipal, action: string, resource: Resource): BoundSql {
  const where = (row: ResourceRow) => maySql(principal, action as never, row as never)
  switch (resource.kind) {
    case "workspace": {
      const rule = where({ kind: "workspace", alias: "w" })
      return { sql: `select 1 from workspaces w where w.workspace_id = ? and ${rule.sql}`, bind: [resource.workspaceId, ...rule.bind] }
    }
    case "session": {
      const rule = where({ kind: "session", alias: "s" })
      return {
        sql: `select 1 from sessions s where s.session_id = ? and s.workspace_id = ? and ${rule.sql}`,
        bind: [resource.sessionId, resource.workspaceId, ...rule.bind],
      }
    }
    case "project": {
      const rule = where({ kind: "project", alias: "p" })
      return {
        sql: `select 1 from projects p where p.project_id = ? and p.org_id = coalesce(?, p.org_id) and ${rule.sql}`,
        bind: [resource.projectId, resource.orgId ?? null, ...rule.bind],
      }
    }
    case "org": {
      const rule = where({ kind: "org", orgId: "o.org_id" })
      return { sql: `select 1 from orgs o where o.org_id = ? and ${rule.sql}`, bind: [resource.orgId, ...rule.bind] }
    }
  }
}

const USER = "\u0000user\u0000"
const ACTOR = "\u0000actor\u0000"

/** The rule names the principal by marker; each occurrence becomes one bound `?`, in order. */
function bindPrincipal(template: string, principal: AuthorizationPrincipal): BoundSql {
  const bind: unknown[] = []
  const sql = template.replace(/\u0000(user|actor)\u0000/g, (_, which: string) => {
    bind.push(which === "user" ? principal.userId : principal.actorId)
    return "?"
  })
  return { sql, bind }
}

function activePrincipalSql(withActor: boolean) {
  return withActor
    ? `exists (
      select 1 from actors principal_actor
      join users principal_user on principal_user.user_id = principal_actor.user_id and principal_user.state = 'active'
      where principal_actor.actor_id = ${ACTOR} and principal_actor.user_id = ${USER} and principal_actor.state = 'active'
    )`
    : `exists (select 1 from users principal_user where principal_user.user_id = ${USER} and principal_user.state = 'active')`
}

function workspaceRuleSql(action: WorkspaceAction, w: string) {
  const live = action === "assign_host"
    ? `(${w}.deleted_at is null or ${w}.backing = 'local-worktree')`
    : `${w}.deleted_at is null`
  return `(${live} and ${w}.owner_user_id = ${USER}
    and ${orgMemberSql(`${w}.org_id`, USER)}
    and exists (
      select 1 from projects rule_project
      where rule_project.project_id = ${w}.project_id and rule_project.org_id = ${w}.org_id
        and rule_project.deleted_at is null
    ))`
}

function sessionRuleSql(action: SessionAction, s: string, withActor: boolean) {
  const share = action === "read" || action === "send" ? ` or ${sessionShareSql(s, action === "send", withActor)}` : ""
  return `(${s}.deleted_at is null
    and ${orgMemberSql(`${s}.org_id`, USER)}
    and exists (
      select 1 from workspaces rule_workspace
      join projects rule_project on rule_project.project_id = rule_workspace.project_id
        and rule_project.org_id = rule_workspace.org_id and rule_project.deleted_at is null
      where rule_workspace.workspace_id = ${s}.workspace_id
        and rule_workspace.org_id = ${s}.org_id
        and rule_workspace.project_id = ${s}.project_id
        and rule_workspace.deleted_at is null
        -- A share reaches its session only while the owner still stands.
        and exists (
          select 1 from users rule_owner
          where rule_owner.user_id = rule_workspace.owner_user_id and rule_owner.state = 'active'
        )
        and ${orgMemberSql("rule_workspace.org_id", "rule_workspace.owner_user_id")}
        and (rule_workspace.owner_user_id = ${USER}${share})
    ))`
}

/**
 * A live share on this session naming the person. `send` narrows it to a share
 * at that level; an actor that is not human never holds one.
 */
function sessionShareSql(s: string, send: boolean, withActor: boolean) {
  return `exists (select 1 from session_share_grants share where ${sharePredicateSql(s, send, withActor)})`
}

/**
 * The share a runtime token is recorded under, for a principal `session` reads
 * through a share. Null for the workspace's owner, whose access no share admits.
 */
export function admittingShareSql(principal: AuthorizationPrincipal, session: string): BoundSql {
  return bindPrincipal(`(
    select case when rule_workspace.owner_user_id = ${USER} then null else (
      select share.grant_id from session_share_grants share
      where ${sharePredicateSql(session, false, principal.actorId !== undefined)}
      limit 1
    ) end
    from workspaces rule_workspace where rule_workspace.workspace_id = ${session}.workspace_id
  )`, principal)
}

function sharePredicateSql(s: string, send: boolean, withActor: boolean) {
  return `share.session_id = ${s}.session_id and share.revoked_at is null
      ${send ? "and share.level = 'send'" : ""}
      ${withActor ? `and exists (select 1 from actors share_actor where share_actor.actor_id = ${ACTOR} and share_actor.kind = 'human')` : ""}
      and share.target_user_id = ${USER}`
}

function projectRuleSql(action: ProjectAction, p: string) {
  return `(${p}.deleted_at is null
    and ${orgMemberSql(`${p}.org_id`, USER)}
    and ${projectRoleRankSql({ user: USER, projectId: `${p}.project_id`, orgId: `${p}.org_id`, ownerUserId: `${p}.owner_user_id` })}
      >= ${actionRank(action)})`
}

function orgRuleSql(action: OrgAction, orgId: string) {
  if (action === "member") return orgMemberSql(orgId, USER)
  const roles = action === "administer" ? "'owner', 'admin'" : "'owner'"
  return `exists (
    select 1 from orgs rule_org
    left join org_memberships rule_org_member
      on rule_org_member.org_id = rule_org.org_id and rule_org_member.user_id = ${USER}
      and rule_org_member.revoked_at is null
    where rule_org.org_id = ${orgId} and rule_org.deleted_at is null
      and (rule_org.owner_user_id = ${USER} or rule_org_member.role in (${roles}))
  )`
}

function roleRankSql(column: string) {
  return `case ${column} when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 else 0 end`
}

/**
 * A person's rank on a project: the highest of owning it (4), their own member
 * grant, the best grant of a team they are on in the project's organization,
 * and `orgRoleRankSql`. Organization standing is not checked here; the project
 * rule and `readProjectRole` ask it beside.
 */
function projectRoleRankSql(input: { user: string; projectId: string; orgId: string; ownerUserId: string }) {
  const { user, projectId, orgId } = input
  return `max(
    case when ${input.ownerUserId} = ${user} then 4 else 0 end,
    coalesce((
      select ${roleRankSql("rank_member.role")} from project_memberships rank_member
      where rank_member.project_id = ${projectId} and rank_member.user_id = ${user} and rank_member.revoked_at is null
    ), 0),
    coalesce((
      select max(${roleRankSql("rank_team_grant.role")}) from team_project_grants rank_team_grant
      join team_memberships rank_team_member
        on rank_team_member.team_id = rank_team_grant.team_id and rank_team_member.user_id = ${user}
        and rank_team_member.revoked_at is null
      join teams rank_team
        on rank_team.team_id = rank_team_grant.team_id and rank_team.org_id = ${orgId} and rank_team.deleted_at is null
      where rank_team_grant.project_id = ${projectId} and rank_team_grant.revoked_at is null
    ), 0),
    ${orgRoleRankSql({ user, orgId })}
  )`
}

const PROJECT_RANK_USER_BINDINGS =
  projectRoleRankSql({ user: "?", projectId: "p.project_id", orgId: "p.org_id", ownerUserId: "p.owner_user_id" }).match(/\?/g)!.length

/**
 * What a person's organization role alone is worth on its projects: owners
 * and admins 3, members 1, anyone else 0. The project access listing shows
 * it per member.
 */
export function orgRoleRankSql(input: { user: string; orgId: string }) {
  return `coalesce((
      select case when rank_org.owner_user_id = ${input.user} then 3
        when rank_org_member.role in ('owner', 'admin') then 3
        when rank_org_member.role = 'member' then 1 else 0 end
      from orgs rank_org
      left join org_memberships rank_org_member
        on rank_org_member.org_id = rank_org.org_id and rank_org_member.user_id = ${input.user}
        and rank_org_member.revoked_at is null
      where rank_org.org_id = ${input.orgId} and rank_org.deleted_at is null
    ), 0)`
}

/** Whether `user` (an SQL expression) stands in the live organization `org` names: its founder or an active member. */
export function orgMemberSql(org: string, user: string) {
  return `exists (
    select 1 from orgs member_org
    left join org_memberships member_row
      on member_row.org_id = member_org.org_id and member_row.user_id = ${user} and member_row.revoked_at is null
    where member_org.org_id = ${org} and member_org.deleted_at is null
      and (member_org.owner_user_id = ${user} or member_row.user_id is not null)
  )`
}

function actionRank(action: ProjectAction) {
  return action === "read" ? 1 : action === "write" ? 2 : action === "admin" ? 3 : 4
}

export function rankRole(rank: number): ProjectRole {
  return rank >= 4 ? "owner" : rank >= 3 ? "admin" : rank >= 2 ? "editor" : "viewer"
}
