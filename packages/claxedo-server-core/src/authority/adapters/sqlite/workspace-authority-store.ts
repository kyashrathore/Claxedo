import fs from "node:fs"
import path from "path"
import Database from "better-sqlite3"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { lazy } from "@claxedo/server-core/platform/runtime/lib/lazy"
import { randomToken } from "@claxedo/server-core/platform/auth/web-crypto"
import { canonicalRepositoryKey } from "@claxedo/server-core/authority/repository-key"

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
  public_id TEXT NOT NULL,
  subject TEXT,
  issuer TEXT,
  name TEXT,
  image_url TEXT,
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
  org_id TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  owner_token_identifier TEXT NOT NULL,
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
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
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
  target_key TEXT NOT NULL,
  granted_to_token_identifier TEXT,
  granted_to_subject TEXT,
  granted_to_org_id TEXT,
  role TEXT NOT NULL,
  created_by_token_identifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK (
    (granted_to_token_identifier IS NOT NULL)
    + (granted_to_subject IS NOT NULL)
    + (granted_to_org_id IS NOT NULL) = 1
  )
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
-- Machine-wide remote access (Unit 6). One row per (owner, machine) — NOT per
-- workspace, which is the whole difference from local_host_links above. A user
-- with twelve projects on one laptop enrolls the laptop once; the workspaces a
-- session may reach are decided at request time from the workspace tables, not
-- baked into a registration row.
--
-- The UNIQUE below is that rule, enforced by the database rather than by every
-- caller remembering to check first.
CREATE TABLE IF NOT EXISTS host_enrollments (
  enrollment_id TEXT PRIMARY KEY,
  owner_token_identifier TEXT NOT NULL,
  host_id TEXT NOT NULL,
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
  UNIQUE (owner_token_identifier, host_id)
);
CREATE INDEX IF NOT EXISTS host_enrollments_by_owner ON host_enrollments (owner_token_identifier);
CREATE INDEX IF NOT EXISTS host_enrollments_by_expires_at ON host_enrollments (expires_at);
-- The one-use nonce a machine signs to prove it holds the private key. Separate
-- table from host_attestation_challenges because that one is keyed by workspace
-- and this flow has no workspace to key by.
--
-- expires_at carries TWO meanings over a row's life, and the transition is what
-- bounds the table: while used_at is NULL it is the challenge deadline
-- (ENROLLMENT_CHALLENGE_TTL_MS from creation); once claimed, enrollHost
-- rewrites it to used_at + ENROLLMENT_CONSUMED_RETENTION_MS so the consumed
-- evidence outlives the nonce. Either way it answers one question for the prune
-- in createHostEnrollmentRequest — when may this row be collected — which is
-- why that prune needs no second clock and no status column.
CREATE TABLE IF NOT EXISTS host_enrollment_requests (
  request_id TEXT PRIMARY KEY,
  owner_token_identifier TEXT NOT NULL,
  host_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS host_enrollment_requests_by_owner ON host_enrollment_requests (owner_token_identifier);
-- The prune's range. Without it the bounded delete still deletes the right
-- rows, but it scans every row to find them — which is the growth it exists to
-- stop, paid on the create path instead of in storage.
CREATE INDEX IF NOT EXISTS host_enrollment_requests_by_expires_at ON host_enrollment_requests (expires_at);
CREATE TABLE IF NOT EXISTS runtime_access_tokens (
  jti TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  minted_for_token_identifier TEXT NOT NULL,
  principal_kind TEXT,
  minted_for_actor_kind TEXT,
  workspace_role TEXT,
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
  max_event_ordinal INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS session_messages (
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  author_actor_id TEXT,
  role TEXT,
  ordinal INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, message_id)
);
CREATE TABLE IF NOT EXISTS session_participants (
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_token_identifier TEXT NOT NULL,
  added_by_token_identifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (session_id, actor_token_identifier)
);
CREATE INDEX IF NOT EXISTS session_participants_by_actor ON session_participants (actor_token_identifier);
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

const SQLITE_TENANCY_SCHEMA_VERSION = 2

/**
 * Upgrades pre-tenant local authority databases in one SQLite transaction.
 * Ambiguous provenance aborts the transaction with the offending row id;
 * operators can inspect/correct that row and safely reopen to resume.
 */
export function migrateAuthorityTenancySchema(db: SqliteAuthorityDb) {
  db.transaction(() => {
    addColumn(db, "users", "public_id", "TEXT")
    addColumn(db, "users", "name", "TEXT")
    addColumn(db, "users", "image_url", "TEXT")
    addColumn(db, "projects", "repo_key", "TEXT")
    addColumn(db, "runtime_access_tokens", "workspace_role", "TEXT")
    addColumn(db, "runtime_access_tokens", "principal_kind", "TEXT")
    addColumn(db, "runtime_access_tokens", "minted_for_actor_kind", "TEXT")
    addColumn(db, "workspace_share_grants", "target_key", "TEXT")

    if (tableExists(db, "workspace_share_grants")) {
      if (tableExists(db, "orgs")) {
        db.exec(`
          UPDATE workspace_share_grants AS share
          SET granted_to_org_id = (
            SELECT org_id FROM orgs
            WHERE clerk_org_id = share.granted_to_org_id AND deleted_at IS NULL
            LIMIT 1
          )
          WHERE granted_to_org_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM orgs
              WHERE clerk_org_id = share.granted_to_org_id AND deleted_at IS NULL
            );
        `)
      }
      const subjectTargetSql = tableExists(db, "users")
        ? `WHEN granted_to_subject IS NOT NULL AND (
            SELECT COUNT(*) FROM users WHERE subject = granted_to_subject
          ) = 1 THEN 'token:' || (
            SELECT token_identifier FROM users WHERE subject = granted_to_subject LIMIT 1
          )
          WHEN granted_to_subject IS NOT NULL THEN 'subject:' || granted_to_subject`
        : "WHEN granted_to_subject IS NOT NULL THEN 'subject:' || granted_to_subject"
      const invalidShare = db.prepare(`
        SELECT grant_id FROM workspace_share_grants
        WHERE revoked_at IS NULL AND (
          (granted_to_token_identifier IS NOT NULL)
          + (granted_to_subject IS NOT NULL)
          + (granted_to_org_id IS NOT NULL) != 1
        )
        LIMIT 1
      `).get() as { grant_id: string } | undefined
      if (invalidShare) throw new Error(`workspace_share_target_invalid:${invalidShare.grant_id}`)
      db.exec(`
        UPDATE workspace_share_grants
        SET target_key = CASE
          WHEN granted_to_token_identifier IS NOT NULL THEN 'token:' || granted_to_token_identifier
          ${subjectTargetSql}
          WHEN granted_to_org_id IS NOT NULL THEN 'org:' || granted_to_org_id
        END
        WHERE target_key IS NULL;
        UPDATE workspace_share_grants
        SET revoked_at = created_at
        WHERE grant_id IN (
          SELECT grant_id FROM (
            SELECT grant_id, ROW_NUMBER() OVER (
              PARTITION BY workspace_id, target_key
              ORDER BY created_at DESC, grant_id DESC
            ) AS duplicate_rank
            FROM workspace_share_grants
            WHERE revoked_at IS NULL AND target_key IS NOT NULL
          ) WHERE duplicate_rank > 1
        );
        CREATE UNIQUE INDEX IF NOT EXISTS workspace_share_grants_active_target
        ON workspace_share_grants (workspace_id, target_key)
        WHERE revoked_at IS NULL AND target_key IS NOT NULL;
      `)
    }

    db.exec(`
      UPDATE users
      SET public_id = 'usr_legacy_' || lower(hex(randomblob(16)))
      WHERE public_id IS NULL OR trim(public_id) = '';
      UPDATE users SET kind = 'human' WHERE kind IS NULL OR trim(kind) = '';
      UPDATE projects
      SET repo_key = 'workspace:' || project_id
      WHERE repo_key IS NULL OR trim(repo_key) = '';
    `)

    for (const workspace of db.prepare(`
      SELECT workspace_id, org_id, project_id, owner_token_identifier, repo_url, remote_directory,
             created_at, updated_at
      FROM workspaces
    `).all() as Array<LegacyWorkspaceRow>) {
      if (workspace.org_id) continue
      const orgIds = new Set<string>()
      if (workspace.project_id) {
        const project = db.prepare("SELECT org_id FROM projects WHERE project_id = ?")
          .get(workspace.project_id) as { org_id: string | null } | undefined
        if (project?.org_id) orgIds.add(project.org_id)
      }
      if (orgIds.size === 0) {
        for (const orgId of userOrganizationIds(db, workspace.owner_token_identifier)) orgIds.add(orgId)
      }
      if (orgIds.size !== 1) throw new Error(`workspace_organization_unresolved:${workspace.workspace_id}`)
      db.prepare("UPDATE workspaces SET org_id = ? WHERE workspace_id = ?")
        .run([...orgIds][0], workspace.workspace_id)
    }

    for (const project of db.prepare(`
      SELECT project_id, org_id, repo_key, owner_token_identifier, created_at, updated_at
      FROM projects
    `).all() as Array<LegacyProjectRow>) {
      const linked = db.prepare(`
        SELECT DISTINCT org_id, owner_token_identifier FROM workspaces
        WHERE project_id = ? AND org_id IS NOT NULL
      `).all(project.project_id) as Array<{ org_id: string; owner_token_identifier: string }>
      const orgIds = new Set(project.org_id ? [project.org_id] : linked.map((workspace) => workspace.org_id))
      if (orgIds.size === 0 && project.owner_token_identifier) {
        for (const orgId of userOrganizationIds(db, project.owner_token_identifier)) orgIds.add(orgId)
      }
      if (orgIds.size !== 1) throw new Error(`project_organization_unresolved:${project.project_id}`)
      const orgId = [...orgIds][0]
      const owners = new Set(project.owner_token_identifier
        ? [project.owner_token_identifier]
        : linked.map((workspace) => workspace.owner_token_identifier))
      const org = db.prepare("SELECT owner_token_identifier FROM orgs WHERE org_id = ?")
        .get(orgId) as { owner_token_identifier: string | null } | undefined
      if (owners.size === 0 && org?.owner_token_identifier) owners.add(org.owner_token_identifier)
      if (owners.size !== 1) throw new Error(`project_owner_unresolved:${project.project_id}`)
      db.prepare(`
        UPDATE projects SET org_id = ?, owner_token_identifier = ? WHERE project_id = ?
      `).run(orgId, [...owners][0], project.project_id)
    }

    for (const workspace of db.prepare(`
      SELECT workspace_id, org_id, project_id, owner_token_identifier, repo_url, remote_directory,
             created_at, updated_at
      FROM workspaces WHERE project_id IS NULL OR trim(project_id) = ''
    `).all() as Array<LegacyWorkspaceRow>) {
      if (!workspace.org_id) throw new Error(`workspace_organization_unresolved:${workspace.workspace_id}`)
      const repoKey = sqliteRepoKey(workspace.repo_url ?? workspace.remote_directory, workspace.workspace_id)
      const matching = db.prepare("SELECT project_id FROM projects WHERE org_id = ? AND repo_key = ?")
        .get(workspace.org_id, repoKey) as { project_id: string } | undefined
      const projectId = matching?.project_id ?? `prj_legacy_${workspace.workspace_id}`
      if (!matching) {
        const collision = db.prepare("SELECT org_id, repo_key FROM projects WHERE project_id = ?")
          .get(projectId) as { org_id: string; repo_key: string } | undefined
        if (collision && (collision.org_id !== workspace.org_id || collision.repo_key !== repoKey)) {
          throw new Error(`workspace_project_identity_conflict:${workspace.workspace_id}:${projectId}`)
        }
        db.prepare(`
          INSERT OR IGNORE INTO projects
            (project_id, org_id, repo_key, owner_token_identifier, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          projectId,
          workspace.org_id,
          repoKey,
          workspace.owner_token_identifier,
          workspace.created_at,
          workspace.updated_at,
        )
      }
      db.prepare("UPDATE workspaces SET project_id = ? WHERE workspace_id = ?")
        .run(projectId, workspace.workspace_id)
    }

    requireNoNull(db, "users", "public_id", "token_identifier")
    requireNoNull(db, "projects", "org_id", "project_id")
    requireNoNull(db, "projects", "repo_key", "project_id")
    requireNoNull(db, "projects", "owner_token_identifier", "project_id")
    requireNoNull(db, "workspaces", "org_id", "workspace_id")
    requireNoNull(db, "workspaces", "project_id", "workspace_id")
    requireUnique(db, "users", ["public_id"])
    requireUnique(db, "projects", ["org_id", "repo_key"])
    const mismatchedWorkspace = db.prepare(`
      SELECT w.workspace_id FROM workspaces w
      LEFT JOIN projects p ON p.project_id = w.project_id AND p.org_id = w.org_id
      WHERE p.project_id IS NULL LIMIT 1
    `).get() as { workspace_id: string } | undefined
    if (mismatchedWorkspace) {
      throw new Error(`workspace_project_tenant_unresolved:${mismatchedWorkspace.workspace_id}`)
    }

    rebuildUsersIfNeeded(db)
    rebuildProjectsIfNeeded(db)
    rebuildWorkspacesIfNeeded(db)
    db.exec(`
      CREATE INDEX IF NOT EXISTS users_by_subject ON users (subject);
      CREATE UNIQUE INDEX IF NOT EXISTS users_by_public_id ON users (public_id);
      CREATE INDEX IF NOT EXISTS projects_by_org ON projects (org_id);
      CREATE UNIQUE INDEX IF NOT EXISTS projects_by_org_repo_key ON projects (org_id, repo_key);
      CREATE INDEX IF NOT EXISTS workspaces_by_org ON workspaces (org_id);
      CREATE INDEX IF NOT EXISTS workspaces_by_project ON workspaces (project_id);
      CREATE TRIGGER IF NOT EXISTS workspaces_tenant_project_insert
      BEFORE INSERT ON workspaces
      WHEN NOT EXISTS (
        SELECT 1 FROM projects p WHERE p.project_id = NEW.project_id AND p.org_id = NEW.org_id
      ) BEGIN
        SELECT RAISE(ABORT, 'workspace_project_tenant_conflict');
      END;
      CREATE TRIGGER IF NOT EXISTS workspaces_tenant_project_update
      BEFORE UPDATE OF org_id, project_id ON workspaces
      WHEN NOT EXISTS (
        SELECT 1 FROM projects p WHERE p.project_id = NEW.project_id AND p.org_id = NEW.org_id
      ) BEGIN
        SELECT RAISE(ABORT, 'workspace_project_tenant_conflict');
      END;
      CREATE TRIGGER IF NOT EXISTS projects_tenant_reassignment
      BEFORE UPDATE OF org_id ON projects
      WHEN EXISTS (
        SELECT 1 FROM workspaces w WHERE w.project_id = OLD.project_id AND w.org_id != NEW.org_id
      ) BEGIN
        SELECT RAISE(ABORT, 'project_tenant_reassignment');
      END;
      PRAGMA user_version = ${SQLITE_TENANCY_SCHEMA_VERSION};
    `)
  })()
}

type LegacyWorkspaceRow = {
  workspace_id: string
  org_id: string | null
  project_id: string | null
  owner_token_identifier: string
  repo_url: string | null
  remote_directory: string | null
  created_at: number
  updated_at: number
}

type LegacyProjectRow = {
  project_id: string
  org_id: string | null
  repo_key: string | null
  owner_token_identifier: string | null
  created_at: number
  updated_at: number
}

function addColumn(db: SqliteAuthorityDb, table: string, column: string, definition: string) {
  if (!tableExists(db, table)) return
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (columns.some((item) => item.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

function tableExists(db: SqliteAuthorityDb, table: string) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
}

function userOrganizationIds(db: SqliteAuthorityDb, tokenIdentifier: string) {
  return (db.prepare(`
    SELECT DISTINCT o.org_id FROM orgs o
    LEFT JOIN org_memberships m ON m.org_id = o.org_id
    WHERE o.deleted_at IS NULL
      AND (o.owner_token_identifier = ? OR m.token_identifier = ?)
  `).all(tokenIdentifier, tokenIdentifier) as Array<{ org_id: string }>).map((row) => row.org_id)
}

export function sqliteRepoKey(value: string | null | undefined, workspaceId: string) {
  return canonicalRepositoryKey({
    ...(value && /^(?:[a-z][a-z0-9+.-]*:\/\/|[^@/\s]+@[^:/\s]+:)/i.test(value)
      ? { repoUrl: value }
      : { remoteDirectory: value }),
    workspaceId,
  })
}

function requireNoNull(db: SqliteAuthorityDb, table: string, column: string, identity: string) {
  const row = db.prepare(`SELECT ${identity} AS identity FROM ${table} WHERE ${column} IS NULL OR trim(${column}) = '' LIMIT 1`)
    .get() as { identity: string } | undefined
  if (row) throw new Error(`${table}_${column}_unresolved:${row.identity}`)
}

function requireUnique(db: SqliteAuthorityDb, table: string, columns: string[]) {
  const row = db.prepare(`
    SELECT ${columns.join(", ")}, COUNT(*) AS count FROM ${table}
    GROUP BY ${columns.join(", ")} HAVING COUNT(*) > 1 LIMIT 1
  `).get() as Record<string, unknown> | undefined
  if (row) throw new Error(`${table}_${columns.join("_")}_duplicate:${JSON.stringify(row)}`)
}

function columnRequired(db: SqliteAuthorityDb, table: string, column: string) {
  const row = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>)
    .find((item) => item.name === column)
  return row?.notnull === 1
}

function rebuildUsersIfNeeded(db: SqliteAuthorityDb) {
  if (columnRequired(db, "users", "public_id")) return
  db.exec(`
    CREATE TABLE users_tenant_v2 (
      token_identifier TEXT PRIMARY KEY,
      public_id TEXT NOT NULL,
      subject TEXT,
      issuer TEXT,
      name TEXT,
      image_url TEXT,
      kind TEXT NOT NULL DEFAULT 'human',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO users_tenant_v2
      (token_identifier, public_id, subject, issuer, name, image_url, kind, created_at, updated_at)
    SELECT token_identifier, public_id, subject, issuer, name, image_url, kind, created_at, updated_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_tenant_v2 RENAME TO users;
  `)
}

function rebuildProjectsIfNeeded(db: SqliteAuthorityDb) {
  if (
    columnRequired(db, "projects", "org_id")
    && columnRequired(db, "projects", "repo_key")
    && columnRequired(db, "projects", "owner_token_identifier")
  ) return
  db.exec(`
    CREATE TABLE projects_tenant_v2 (
      project_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      repo_key TEXT NOT NULL,
      owner_token_identifier TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    INSERT INTO projects_tenant_v2
      (project_id, org_id, repo_key, owner_token_identifier, created_at, updated_at, deleted_at)
    SELECT project_id, org_id, repo_key, owner_token_identifier, created_at, updated_at, deleted_at FROM projects;
    DROP TABLE projects;
    ALTER TABLE projects_tenant_v2 RENAME TO projects;
  `)
}

function rebuildWorkspacesIfNeeded(db: SqliteAuthorityDb) {
  if (columnRequired(db, "workspaces", "org_id") && columnRequired(db, "workspaces", "project_id")) return
  db.exec(`
    CREATE TABLE workspaces_tenant_v2 (
      workspace_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
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
    INSERT INTO workspaces_tenant_v2
      (workspace_id, org_id, project_id, owner_token_identifier, backing, access, display_name,
       second_device_open_at, home_region, repo_url, repo_name, git_branch, remote_directory,
       created_at, updated_at, deleted_at)
    SELECT workspace_id, org_id, project_id, owner_token_identifier, backing, access, display_name,
       second_device_open_at, home_region, repo_url, repo_name, git_branch, remote_directory,
       created_at, updated_at, deleted_at FROM workspaces;
    DROP TABLE workspaces;
    ALTER TABLE workspaces_tenant_v2 RENAME TO workspaces;
  `)
}

export function openAuthorityDb(options: SqliteWorkspaceAuthorityOptions = {}) {
  const entry: TrackedAuthorityDb = {
    handle: lazy(() => {
      const file = options.path ?? path.join(dataDir(), "authority.db")
      const existing = file !== ":memory:" && fs.existsSync(file)
      if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true })
      const db = new Database(file)
      try {
        db.pragma("journal_mode = WAL")
        db.pragma("synchronous = NORMAL")
        db.pragma("busy_timeout = 5000")
        if (existing && Number(db.pragma("user_version", { simple: true })) < SQLITE_TENANCY_SCHEMA_VERSION) {
          const [checkpoint] = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{
            busy: number
            log: number
            checkpointed: number
          }>
          if (!checkpoint || checkpoint.busy || checkpoint.log !== checkpoint.checkpointed) {
            throw new Error("authority_backup_checkpoint_incomplete")
          }
          const backup = `${file}.pre-tenancy-v${SQLITE_TENANCY_SCHEMA_VERSION}.bak`
          if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
        }
        db.exec(SCHEMA)
        const localHostColumns = db.prepare("PRAGMA table_info(local_host_links)").all() as Array<{ name: string }>
        if (!localHostColumns.some((column) => column.name === "second_device_open_at")) {
          db.exec("ALTER TABLE local_host_links ADD COLUMN second_device_open_at INTEGER")
        }
        const sessionHistoryColumns = db.prepare("PRAGMA table_info(session_history)").all() as Array<{ name: string }>
        if (!sessionHistoryColumns.some((column) => column.name === "max_event_ordinal")) {
          db.exec("ALTER TABLE session_history ADD COLUMN max_event_ordinal INTEGER NOT NULL DEFAULT 0")
        }
        migrateAuthorityTenancySchema(db)
        const messageColumns = db.prepare("PRAGMA table_info(session_messages)").all() as Array<{ name: string }>
        if (!messageColumns.some((column) => column.name === "author_actor_id")) {
          db.exec("ALTER TABLE session_messages ADD COLUMN author_actor_id TEXT")
        }
        db.exec("CREATE INDEX IF NOT EXISTS session_history_by_creator ON session_history (created_by_token_identifier)")
        db.exec(`
          CREATE INDEX IF NOT EXISTS session_history_by_workspace_creator
          ON session_history (workspace_id, created_by_token_identifier, updated_at DESC)
        `)
      } catch (error) {
        db.close()
        throw error
      }
      entry.db = db
      tracked.add(entry)
      return db
    }),
  }
  return Object.assign(entry.handle, {
    close() {
      try {
        entry.db?.close()
      } finally {
        entry.db = undefined
        entry.handle.reset()
        tracked.delete(entry)
      }
    },
  })
}

type TrackedAuthorityDb = {
  handle: (() => SqliteAuthorityDb) & { reset(): void }
  db?: SqliteAuthorityDb
}

const tracked = new Set<TrackedAuthorityDb>()

/**
 * Close every authority database this process has opened.
 *
 * The compositions hold their `openAuthorityDb` handle privately, so without
 * this there is no way to release the underlying file — which Windows requires
 * before the containing directory can be deleted (POSIX unlinks an open file;
 * NT refuses with EBUSY). The same registry-close shape as `ClaxedoDB.close()`:
 * handles are reset, not invalidated, so the next use reopens cleanly.
 */
export function closeAuthorityDatabases() {
  for (const entry of tracked) {
    try {
      entry.db?.close()
    } catch {
      // A handle that is already closed or mid-teardown is exactly what this
      // sweep exists to tolerate.
    }
    entry.db = undefined
    entry.handle.reset()
  }
  tracked.clear()
}

// --- identity + role model (mirror of convex/model.ts) ---------------------

export type AuthorityUser = {
  token_identifier: string
  public_id?: string
  subject?: string
  name?: string
  image_url?: string
  kind?: "human" | "agent"
}

export type WorkspaceRow = {
  workspace_id: string
  org_id: string
  project_id: string
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
  org_id: string
  repo_key: string
  owner_token_identifier: string
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

export function roleAtLeast(actual: WorkspaceRole, required: WorkspaceRole) {
  return roleRank[actual] >= roleRank[required]
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
  const existing = db.prepare(`SELECT public_id FROM users WHERE token_identifier = ?`)
    .get(user.token_identifier) as { public_id: string | null } | undefined
  const publicId = existing?.public_id ?? `usr_${randomToken()}`
  db.prepare(`
    INSERT INTO users (token_identifier, public_id, subject, issuer, name, image_url, kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (token_identifier) DO UPDATE SET
      public_id = COALESCE(users.public_id, excluded.public_id),
      subject = excluded.subject,
      issuer = excluded.issuer,
      name = COALESCE(excluded.name, users.name),
      image_url = COALESCE(excluded.image_url, users.image_url),
      kind = users.kind,
      updated_at = excluded.updated_at
  `).run(
    user.token_identifier,
    publicId,
    user.subject ?? null,
    user.issuer ?? null,
    user.name ?? null,
    user.image_url ?? null,
    user.kind ?? "human",
    now,
    now,
  )
  return db.prepare(`
    SELECT token_identifier, public_id, subject, name, image_url, kind
    FROM users WHERE token_identifier = ?
  `).get(user.token_identifier) as AuthorityUser
}

export function userBySubject(db: SqliteAuthorityDb, subject: string) {
  const rows = usersBySubject(db, subject)
  return rows.length === 1 ? rows[0] : undefined
}

export function usersBySubject(db: SqliteAuthorityDb, subject: string) {
  return db.prepare(`SELECT token_identifier, subject FROM users WHERE subject = ? LIMIT 2`)
    .all(subject) as AuthorityUser[]
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
  repoKey: string
  owner: AuthorityUser
}) {
  return db.transaction(() => {
    const now = Date.now()
    const matching = db.prepare(`SELECT project_id FROM projects WHERE org_id = ? AND repo_key = ?`)
      .get(input.orgId, input.repoKey) as { project_id: string } | undefined
    const projectId = matching?.project_id ?? input.projectId
    const requested = db.prepare(`SELECT org_id, repo_key FROM projects WHERE project_id = ?`)
      .get(projectId) as { org_id: string | null; repo_key: string } | undefined
    if (requested?.org_id !== undefined && requested.org_id !== input.orgId) throw new Error("project_tenant_conflict")
    if (requested && requested.repo_key !== input.repoKey) {
      if (!requested.repo_key.startsWith("workspace:") || matching) throw new Error("project_repo_conflict")
      db.prepare(`UPDATE projects SET repo_key = ?, updated_at = ? WHERE project_id = ?`)
        .run(input.repoKey, now, projectId)
    }
    db.prepare(`
      INSERT INTO projects (project_id, org_id, repo_key, owner_token_identifier, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id) DO NOTHING
    `).run(projectId, input.orgId, input.repoKey, input.owner.token_identifier, now, now)
    db.prepare(`
      INSERT INTO project_memberships (project_id, token_identifier, role, created_at, updated_at)
      VALUES (?, ?, 'owner', ?, ?)
      ON CONFLICT (project_id, token_identifier) DO NOTHING
    `).run(projectId, input.owner.token_identifier, now, now)
    return projectId
  })()
}

export function workspaceByPublicId(db: SqliteAuthorityDb, workspaceId: string) {
  return db.prepare(`SELECT * FROM workspaces WHERE workspace_id = ?`)
    .get(workspaceId) as WorkspaceRow | undefined
}

export function projectByPublicId(db: SqliteAuthorityDb, projectId: string) {
  return db.prepare(`SELECT project_id, org_id, repo_key, owner_token_identifier, deleted_at FROM projects WHERE project_id = ?`)
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
  const org = db.prepare(`SELECT owner_token_identifier, deleted_at FROM orgs WHERE org_id = ?`).get(orgId) as {
    owner_token_identifier: string | null
    deleted_at: number | null
  } | undefined
  if (!org || org.deleted_at) return
  const row = db.prepare(`SELECT role FROM org_memberships WHERE org_id = ? AND token_identifier = ?`)
    .get(orgId, user.token_identifier) as { role: string } | undefined
  if (row?.role === "member" || row?.role === "admin" || row?.role === "owner") return orgWorkspaceRole(row.role)
  if (org.owner_token_identifier === user.token_identifier) return "admin" as const
}

export function orgAdminForUser(db: SqliteAuthorityDb, user: AuthorityUser, orgId: string | undefined) {
  if (!orgId) return false
  const org = db.prepare(`SELECT owner_token_identifier, deleted_at FROM orgs WHERE org_id = ?`).get(orgId) as {
    owner_token_identifier: string | null
    deleted_at: number | null
  } | undefined
  if (!org || org.deleted_at) return false
  const membership = db.prepare(`SELECT role FROM org_memberships WHERE org_id = ? AND token_identifier = ?`)
    .get(orgId, user.token_identifier) as { role: string } | undefined
  if (membership) return membership.role === "admin" || membership.role === "owner"
  return org.owner_token_identifier === user.token_identifier
}

function shareRole(db: SqliteAuthorityDb, user: AuthorityUser, workspaceId: string) {
  const subjectOwner = user.subject ? userBySubject(db, user.subject) : undefined
  const targetKeys = [
    `token:${user.token_identifier}`,
    ...(subjectOwner?.token_identifier === user.token_identifier ? [`subject:${user.subject}`] : []),
  ]
  const rows = targetKeys.flatMap((targetKey) => db.prepare(`
    SELECT role FROM workspace_share_grants
    WHERE workspace_id = ? AND target_key = ? AND revoked_at IS NULL
  `).all(workspaceId, targetKey) as Array<{ role: string }>)
  return maxRole(rows.map((row) => workspaceRoleValue(row.role)))
}

function orgShareRole(db: SqliteAuthorityDb, user: AuthorityUser, workspaceId: string) {
  const rows = db.prepare(`
    SELECT g.role AS role FROM workspace_share_grants g
    JOIN org_memberships m ON m.org_id = g.granted_to_org_id
    WHERE g.workspace_id = ? AND g.target_key = 'org:' || m.org_id
      AND g.revoked_at IS NULL AND m.token_identifier = ?
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
