import fs from "node:fs"
import path from "path"
import Database from "better-sqlite3"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { lazy } from "@claxedo/server-core/platform/runtime/lib/lazy"
import { randomToken } from "@claxedo/server-core/platform/auth/web-crypto"

// Claxedo's LOCAL workspace-authority storage: the SQLite tables and the
// user/org/project/role model behind `createSqliteWorkspaceAuthority`. The
// schema and role-precedence rules mirror the Convex authority backend
// (`convex/schema.ts` + `convex/model.ts`) so both adapters answer the
// `WorkspaceAuthority` port with the same semantics; only the storage differs.
// Node-only (better-sqlite3): hosted/Worker compositions must never import
// this module (worker.import-graph guard).

export type SqliteAuthorityDb = InstanceType<typeof Database>

export type SqliteWorkspaceAuthorityOptions = {
  /** Database file path. Defaults to `<CLAXEDO_DATA_DIR>/authority.db`; pass `:memory:` in tests. */
  path?: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  token_identifier TEXT PRIMARY KEY,
  subject TEXT,
  issuer TEXT,
  kind TEXT NOT NULL DEFAULT 'human',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_by_subject ON users (subject);
CREATE TABLE IF NOT EXISTS orgs (
  org_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  owner_token_identifier TEXT,
  clerk_org_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS org_memberships (
  org_id TEXT NOT NULL,
  token_identifier TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, token_identifier)
);
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  org_id TEXT,
  owner_token_identifier TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS project_memberships (
  project_id TEXT NOT NULL,
  token_identifier TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, token_identifier)
);
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  org_id TEXT,
  project_id TEXT,
  owner_token_identifier TEXT NOT NULL,
  backing TEXT NOT NULL,
  access TEXT NOT NULL,
  display_name TEXT,
  second_device_open_at INTEGER,
  home_region TEXT,
  repo_url TEXT,
  repo_name TEXT,
  git_branch TEXT,
  remote_directory TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS workspace_memberships (
  workspace_id TEXT NOT NULL,
  token_identifier TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, token_identifier)
);
CREATE TABLE IF NOT EXISTS workspace_share_grants (
  grant_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  granted_to_token_identifier TEXT,
  granted_to_subject TEXT,
  granted_to_org_id TEXT,
  role TEXT NOT NULL,
  created_by_token_identifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS host_attestation_challenges (
  challenge_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_token_identifier TEXT NOT NULL,
  host_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS local_host_links (
  workspace_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  owner_token_identifier TEXT NOT NULL,
  public_key TEXT NOT NULL,
  display_name TEXT,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  paused_at INTEGER,
  paused_by TEXT,
  paused_reason TEXT,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, host_id)
);
CREATE TABLE IF NOT EXISTS runtime_access_tokens (
  jti TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  minted_for_token_identifier TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_extension_installs (
  workspace_id TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  desired TEXT NOT NULL,
  lock TEXT,
  enabled INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (workspace_id, extension_id)
);
CREATE TABLE IF NOT EXISTS agent_extension_policy_overrides (
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  extension_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  PRIMARY KEY (scope, scope_key, extension_id)
);
CREATE TABLE IF NOT EXISTS session_history (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  created_by_token_identifier TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS session_messages (
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  role TEXT,
  ordinal INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, message_id)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_identifier TEXT,
  workspace_id TEXT,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  reason TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_identities (
  channel TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  token_identifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (channel, external_user_id)
);
`

export function openAuthorityDb(options: SqliteWorkspaceAuthorityOptions = {}) {
  return lazy(() => {
    const file = options.path ?? path.join(dataDir(), "authority.db")
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true })
    const db = new Database(file)
    db.pragma("journal_mode = WAL")
    db.pragma("synchronous = NORMAL")
    db.pragma("busy_timeout = 5000")
    db.exec(SCHEMA)
    const localHostColumns = db.prepare("PRAGMA table_info(local_host_links)").all() as Array<{ name: string }>
    if (!localHostColumns.some((column) => column.name === "second_device_open_at")) {
      db.exec("ALTER TABLE local_host_links ADD COLUMN second_device_open_at INTEGER")
    }
    return db
  })
}

// --- identity + role model (mirror of convex/model.ts) ---------------------

export type AuthorityUser = {
  token_identifier: string
  subject?: string
}

export type WorkspaceRow = {
  workspace_id: string
  org_id: string | null
  project_id: string | null
  owner_token_identifier: string
  backing: string
  access: string
  display_name: string | null
  home_region: string | null
  repo_url: string | null
  repo_name: string | null
  git_branch: string | null
  remote_directory: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export type ProjectRow = {
  project_id: string
  org_id: string | null
  owner_token_identifier: string | null
  deleted_at: number | null
}

export type WorkspaceAction = "read" | "write" | "admin" | "owner"
export type WorkspaceRole = "viewer" | "editor" | "admin" | "owner"
type OrgRole = "member" | "admin" | "owner"

const roleRank: Record<WorkspaceRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
}

export function roleAllows(role: WorkspaceRole, action: WorkspaceAction) {
  if (role === "owner") return true
  if (role === "admin") return action !== "owner"
  if (role === "editor") return action === "read" || action === "write"
  return action === "read"
}

function maxRole(roles: Array<WorkspaceRole | undefined>) {
  return roles.filter((role): role is WorkspaceRole => !!role)
    .sort((a, b) => roleRank[b] - roleRank[a])[0]
}

function workspaceRoleValue(input: unknown) {
  return input === "viewer" || input === "editor" || input === "admin" || input === "owner"
    ? input as WorkspaceRole
    : undefined
}

function orgWorkspaceRole(role: OrgRole) {
  if (role === "owner" || role === "admin") return "admin" as const
  return "viewer" as const
}

export function upsertUser(db: SqliteAuthorityDb, user: AuthorityUser & { issuer?: string; kind?: "human" | "agent" }) {
  const now = Date.now()
  db.prepare(`
    INSERT INTO users (token_identifier, subject, issuer, kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (token_identifier) DO UPDATE SET
      subject = excluded.subject,
      issuer = excluded.issuer,
      kind = excluded.kind,
      updated_at = excluded.updated_at
  `).run(user.token_identifier, user.subject ?? null, user.issuer ?? null, user.kind ?? "human", now, now)
  return user
}

export function userBySubject(db: SqliteAuthorityDb, subject: string) {
  return db.prepare(`SELECT token_identifier, subject FROM users WHERE subject = ?`)
    .get(subject) as AuthorityUser | undefined
}

/** The user's personal org, created on first touch (mirror of `personalOrgForUser`). */
export function ensurePersonalOrg(db: SqliteAuthorityDb, user: AuthorityUser) {
  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT org_id FROM orgs
      WHERE owner_token_identifier = ? AND kind = 'personal' AND clerk_org_id IS NULL AND deleted_at IS NULL
    `).get(user.token_identifier) as { org_id: string } | undefined
    if (existing) return existing.org_id
    const now = Date.now()
    const orgId = `org_${randomToken()}`
    db.prepare(`
      INSERT INTO orgs (org_id, name, kind, owner_token_identifier, created_at, updated_at)
      VALUES (?, ?, 'personal', ?, ?, ?)
    `).run(orgId, "Personal", user.token_identifier, now, now)
    db.prepare(`
      INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at)
      VALUES (?, ?, 'owner', ?, ?)
    `).run(orgId, user.token_identifier, now, now)
    return orgId
  })()
}

export function ensureProject(db: SqliteAuthorityDb, input: {
  projectId: string
  orgId: string
  owner: AuthorityUser
}) {
  return db.transaction(() => {
    const now = Date.now()
    db.prepare(`
      INSERT INTO projects (project_id, org_id, owner_token_identifier, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (project_id) DO NOTHING
    `).run(input.projectId, input.orgId, input.owner.token_identifier, now, now)
    db.prepare(`
      INSERT INTO project_memberships (project_id, token_identifier, role, created_at, updated_at)
      VALUES (?, ?, 'owner', ?, ?)
      ON CONFLICT (project_id, token_identifier) DO NOTHING
    `).run(input.projectId, input.owner.token_identifier, now, now)
    return input.projectId
  })()
}

export function workspaceByPublicId(db: SqliteAuthorityDb, workspaceId: string) {
  return db.prepare(`SELECT * FROM workspaces WHERE workspace_id = ?`)
    .get(workspaceId) as WorkspaceRow | undefined
}

export function projectByPublicId(db: SqliteAuthorityDb, projectId: string) {
  return db.prepare(`SELECT project_id, org_id, owner_token_identifier, deleted_at FROM projects WHERE project_id = ?`)
    .get(projectId) as ProjectRow | undefined
}

function directWorkspaceRole(db: SqliteAuthorityDb, user: AuthorityUser, workspaceId: string) {
  const row = db.prepare(`SELECT role FROM workspace_memberships WHERE workspace_id = ? AND token_identifier = ?`)
    .get(workspaceId, user.token_identifier) as { role: string } | undefined
  return workspaceRoleValue(row?.role)
}

function directProjectRole(db: SqliteAuthorityDb, user: AuthorityUser, projectId: string) {
  const row = db.prepare(`SELECT role FROM project_memberships WHERE project_id = ? AND token_identifier = ?`)
    .get(projectId, user.token_identifier) as { role: string } | undefined
  return workspaceRoleValue(row?.role)
}

function directOrgRole(db: SqliteAuthorityDb, user: AuthorityUser, orgId: string) {
  const org = db.prepare(`SELECT deleted_at FROM orgs WHERE org_id = ?`).get(orgId) as { deleted_at: number | null } | undefined
  if (!org || org.deleted_at) return
  const row = db.prepare(`SELECT role FROM org_memberships WHERE org_id = ? AND token_identifier = ?`)
    .get(orgId, user.token_identifier) as { role: string } | undefined
  if (row?.role === "member" || row?.role === "admin" || row?.role === "owner") return orgWorkspaceRole(row.role)
}

function shareRole(db: SqliteAuthorityDb, user: AuthorityUser, workspaceId: string) {
  const rows = db.prepare(`
    SELECT role FROM workspace_share_grants
    WHERE workspace_id = ? AND revoked_at IS NULL
      AND (granted_to_token_identifier = ? OR (granted_to_subject IS NOT NULL AND granted_to_subject = ?))
  `).all(workspaceId, user.token_identifier, user.subject ?? null) as Array<{ role: string }>
  return maxRole(rows.map((row) => workspaceRoleValue(row.role)))
}

function orgShareRole(db: SqliteAuthorityDb, user: AuthorityUser, workspaceId: string) {
  const rows = db.prepare(`
    SELECT g.role AS role FROM workspace_share_grants g
    JOIN org_memberships m ON m.org_id = g.granted_to_org_id
    WHERE g.workspace_id = ? AND g.revoked_at IS NULL AND m.token_identifier = ?
  `).all(workspaceId, user.token_identifier) as Array<{ role: string }>
  return maxRole(rows.map((row) => workspaceRoleValue(row.role)))
}

/** Role precedence mirror of `combineRolePrecedence` in convex/model.ts. */
export function workspaceRoleForUser(db: SqliteAuthorityDb, workspace: WorkspaceRow, user: AuthorityUser) {
  if (workspace.deleted_at) return
  if (workspace.owner_token_identifier === user.token_identifier) return "owner" as const
  const project = workspace.project_id ? projectByPublicId(db, workspace.project_id) : undefined
  return maxRole([
    directWorkspaceRole(db, user, workspace.workspace_id),
    project ? directProjectRole(db, user, project.project_id) : undefined,
    workspace.org_id ? directOrgRole(db, user, workspace.org_id) : undefined,
    shareRole(db, user, workspace.workspace_id),
    orgShareRole(db, user, workspace.workspace_id),
  ])
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

export function projectRoleForUser(db: SqliteAuthorityDb, project: ProjectRow, user: AuthorityUser) {
  if (project.deleted_at) return
  if (project.owner_token_identifier === user.token_identifier) return "owner" as const
  return maxRole([
    directProjectRole(db, user, project.project_id),
    project.org_id ? directOrgRole(db, user, project.org_id) : undefined,
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
