import {
  roleAllows,
  roleAtLeast,
  type AuthorityUser,
  type ProjectRow,
  type SessionShareTargetRow,
  type SqliteAuthorityDb,
  type WorkspaceAction,
  type WorkspaceRole,
  type WorkspaceRow,
} from "./workspace-authority-store"

type OrgRole = "member" | "admin" | "owner"

function maxRole(roles: Array<WorkspaceRole | undefined>): WorkspaceRole | undefined {
  return roles.reduce<WorkspaceRole | undefined>(
    (highest, role) => (role && (!highest || !roleAtLeast(highest, role)) ? role : highest),
    undefined,
  )
}

function workspaceRoleValue(input: unknown): WorkspaceRole | undefined {
  return input === "viewer" || input === "editor" || input === "admin" || input === "owner"
    ? input
    : undefined
}

function orgWorkspaceRole(role: OrgRole) {
  if (role === "owner" || role === "admin") return "admin" as const
  return "viewer" as const
}

function directProjectRole(db: SqliteAuthorityDb, user: AuthorityUser, projectId: string) {
  const row = db.prepare<unknown[], { role: string }>(`SELECT role FROM project_memberships WHERE project_id = ? AND token_identifier = ?`)
    .get(projectId, user.token_identifier)
  return workspaceRoleValue(row?.role)
}

function directOrgRole(db: SqliteAuthorityDb, user: AuthorityUser, orgId: string): WorkspaceRole | undefined {
  const org = db.prepare<unknown[], {
    owner_token_identifier: string | null
    deleted_at: number | null
  }>(`SELECT owner_token_identifier, deleted_at FROM orgs WHERE org_id = ?`).get(orgId)
  if (!org || org.deleted_at) return undefined
  const row = db.prepare<unknown[], { role: string }>(`SELECT role FROM org_memberships WHERE org_id = ? AND token_identifier = ?`)
    .get(orgId, user.token_identifier)
  if (row?.role === "member" || row?.role === "admin" || row?.role === "owner") return orgWorkspaceRole(row.role)
  if (org.owner_token_identifier === user.token_identifier) return "admin"
  return undefined
}

/**
 * Being in the organization is what makes a person offerable as a share
 * recipient. It carries no standing on the session, the workspace or the
 * machine; only the grant they are then given does.
 */
export function orgMemberForUser(db: SqliteAuthorityDb, user: AuthorityUser, orgId: string | undefined) {
  if (!orgId) return false
  const org = db.prepare<unknown[], {
    owner_token_identifier: string | null
    deleted_at: number | null
  }>(`SELECT owner_token_identifier, deleted_at FROM orgs WHERE org_id = ?`).get(orgId)
  if (!org || org.deleted_at) return false
  const membership = db.prepare<unknown[], { token_identifier: string }>(`SELECT token_identifier FROM org_memberships WHERE org_id = ? AND token_identifier = ?`)
    .get(orgId, user.token_identifier)
  return !!membership || org.owner_token_identifier === user.token_identifier
}

export function orgAdminForUser(db: SqliteAuthorityDb, user: AuthorityUser, orgId: string | undefined) {
  if (!orgId) return false
  const org = db.prepare<unknown[], {
    owner_token_identifier: string | null
    deleted_at: number | null
  }>(`SELECT owner_token_identifier, deleted_at FROM orgs WHERE org_id = ?`).get(orgId)
  if (!org || org.deleted_at) return false
  const membership = db.prepare<unknown[], { role: string }>(`SELECT role FROM org_memberships WHERE org_id = ? AND token_identifier = ?`)
    .get(orgId, user.token_identifier)
  if (membership) return membership.role === "admin" || membership.role === "owner"
  return org.owner_token_identifier === user.token_identifier
}

function teamProjectRole(
  db: SqliteAuthorityDb,
  user: AuthorityUser,
  projectId: string,
  orgId: string,
): WorkspaceRole | undefined {
  const memberships = db.prepare<unknown[], { team_id: string }>(`
    SELECT m.team_id AS team_id FROM team_memberships m
    JOIN teams t ON t.team_id = m.team_id
    WHERE m.user_token_identifier = ? AND m.revoked_at IS NULL AND t.org_id = ? AND t.deleted_at IS NULL
  `).all(user.token_identifier, orgId)
  const roles: Array<WorkspaceRole | undefined> = []
  for (const membership of memberships) {
    const grant = db.prepare<unknown[], { role: string }>(`
      SELECT role FROM team_project_grants
      WHERE team_id = ? AND project_id = ? AND revoked_at IS NULL
    `).get(membership.team_id, projectId)
    if (grant) roles.push(workspaceRoleValue(grant.role))
  }
  return maxRole(roles)
}

/**
 * A workspace is a folder on its owner's machine: its owner, while they stand
 * in its organization, holds every workspace action and nobody else holds any.
 */
export function workspaceRoleForUser(
  db: SqliteAuthorityDb,
  workspace: WorkspaceRow,
  user: AuthorityUser,
): WorkspaceRole | undefined {
  if (workspace.deleted_at || workspace.owner_token_identifier !== user.token_identifier) return undefined
  return orgMemberForUser(db, user, workspace.org_id ?? undefined) ? "owner" : undefined
}

export function authorizeWorkspaceForUser(
  db: SqliteAuthorityDb,
  workspace: WorkspaceRow,
  user: AuthorityUser,
  action: WorkspaceAction,
) {
  const role = workspaceRoleForUser(db, workspace, user)
  return role && roleAllows(role, action) ? role : undefined
}

/**
 * Only someone standing in the project's organization holds a project role:
 * the highest of owning it, their member grant, their organization role and
 * their teams' grants.
 */
export function projectRoleForUser(
  db: SqliteAuthorityDb,
  project: ProjectRow,
  user: AuthorityUser,
): WorkspaceRole | undefined {
  if (project.deleted_at || !orgMemberForUser(db, user, project.org_id)) return undefined
  if (project.owner_token_identifier === user.token_identifier) return "owner"
  return maxRole([
    directProjectRole(db, user, project.project_id),
    directOrgRole(db, user, project.org_id),
    teamProjectRole(db, user, project.project_id, project.org_id),
  ])
}

export function authorizeProjectForUser(
  db: SqliteAuthorityDb,
  project: ProjectRow,
  user: AuthorityUser,
  action: WorkspaceAction,
) {
  const role = projectRoleForUser(db, project, user)
  return role && roleAllows(role, action) ? role : undefined
}

/** A share's target names the person directly, through their organization, or through a team they are still on. */
export function shareTargetsUser(db: SqliteAuthorityDb, grant: SessionShareTargetRow, tokenIdentifier: string) {
  if (grant.granted_to_user_token_identifier === tokenIdentifier) return true
  if (grant.granted_to_org_id && db.prepare(`
    SELECT 1 FROM org_memberships WHERE org_id = ? AND token_identifier = ?
  `).get(grant.granted_to_org_id, tokenIdentifier)) return true
  return !!grant.granted_to_team_id && !!db.prepare(`
    SELECT 1 FROM team_memberships WHERE team_id = ? AND user_token_identifier = ? AND revoked_at IS NULL
  `).get(grant.granted_to_team_id, tokenIdentifier)
}
