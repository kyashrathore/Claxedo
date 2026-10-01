import { normalizeStoredDirectory } from "@claxedo/server-core/platform/auth/host-connect-contract"
import { hasColumn, hasTable } from "@claxedo/server-core/platform/db/schema-introspection"
import type { SqliteAuthorityDb } from "./workspace-authority-store"

/**
 * Columns the host-connect tables gained after the store's CREATE already ran
 * on a database. Every default is what the pre-connect rows meant: one key
 * version, no acquired instance, enrolled through the account, first
 * assignment revision, no sealing key and no pushed provider configuration.
 * Runs after the tenancy migration because that one rebuilds `workspaces` from
 * an explicit column list and would drop a column added before it.
 *
 * One transaction, and the two repairs at the end run on every open rather
 * than only when a column was just added: a process that died between the
 * ADD COLUMN and the backfill would otherwise leave a counter at 0 under a
 * live assignment at a higher revision, and the next assignment would reissue
 * a revision the host already acked.
 */
export function migrateHostConnectSchema(db: SqliteAuthorityDb) {
  db.transaction(() => {
    addColumn(db, "host_enrollments", "key_version", "INTEGER NOT NULL DEFAULT 1")
    addColumn(db, "host_enrollments", "serving_generation", "INTEGER NOT NULL DEFAULT 0")
    addColumn(db, "host_enrollments", "generation_acquired_at", "INTEGER")
    addColumn(db, "host_enrollments", "enrolled_via", "TEXT NOT NULL DEFAULT 'account'")
    addColumn(db, "host_enrollments", "scope_json", "TEXT")
    addColumn(db, "host_enrollments", "scope_revision", "INTEGER NOT NULL DEFAULT 0")
    addColumn(db, "host_enrollments", "sealing_public_key_json", "TEXT")
    addColumn(db, "host_enrollments", "provider_config_sealed", "TEXT")
    addColumn(db, "host_enrollments", "provider_config_revision", "INTEGER NOT NULL DEFAULT 0")
    addColumn(db, "host_enrollments", "provider_config_acked_revision", "INTEGER NOT NULL DEFAULT 0")
    addColumn(db, "host_enrollments", "provider_config_updated_at", "INTEGER")
    addColumn(db, "host_enrollments", "provider_config_sealed_key_json", "TEXT")
    addColumn(db, "host_enrollments", "provider_config_provider_ids", "TEXT")
    addColumn(db, "host_workspace_assignments", "revision", "INTEGER NOT NULL DEFAULT 1")
    addColumn(db, "workspaces", "host_assignment_revision", "INTEGER NOT NULL DEFAULT 0")
    // The counter only ever rises: a live assignment above it is the higher
    // truth, and a counter above the assignment (an unassign left it there)
    // is kept.
    db.exec(`
      UPDATE workspaces SET host_assignment_revision = (
        SELECT assignment.revision FROM host_workspace_assignments assignment
        WHERE assignment.workspace_id = workspaces.workspace_id
      ) WHERE workspace_id IN (
        SELECT assignment.workspace_id FROM host_workspace_assignments assignment
        JOIN workspaces workspace ON workspace.workspace_id = assignment.workspace_id
        WHERE assignment.revision > workspace.host_assignment_revision
      )
    `)
    normalizeMachinePlacedDirectories(db)
    dropWorkspaceAccessMode(db)
  })()
}

/**
 * Drops `workspaces.access`, whose every value was decided by `backing`.
 *
 * A failure is fatal rather than tolerated: the column is `NOT NULL` with no
 * default and nothing writes it any more, so a database that kept it would
 * refuse every workspace insert. `rebuildWorkspacesIfNeeded` also removes it,
 * but only for a database whose tenancy columns are still nullable.
 */
function dropWorkspaceAccessMode(db: SqliteAuthorityDb) {
  if (!hasColumn(db, "workspaces", "access")) return
  db.exec("ALTER TABLE workspaces DROP COLUMN access")
}

/**
 * Rows written before directories were normalized on the way in. The write
 * paths now store `normalizeStoredDirectory`'s form, so this converges in one
 * pass and rewrites nothing on later opens.
 */
function normalizeMachinePlacedDirectories(db: SqliteAuthorityDb) {
  const rows = db.prepare<unknown[], { workspace_id: string; remote_directory: string }>(`
    SELECT workspace_id, remote_directory FROM workspaces
    WHERE backing = 'local-worktree' AND remote_directory IS NOT NULL
  `).all()
  const update = db.prepare(`UPDATE workspaces SET remote_directory = ? WHERE workspace_id = ?`)
  for (const row of rows) {
    const normalized = normalizeStoredDirectory(row.remote_directory)
    if (normalized !== row.remote_directory) update.run(normalized, row.workspace_id)
  }
}

/** Whether the column was added by this call; an existing column is left as it is. */
export function addColumn(db: SqliteAuthorityDb, table: string, column: string, definition: string) {
  if (!hasTable(db, table)) return false
  if (hasColumn(db, table, column)) return false
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  return true
}

export function renameSharedOrgKind(db: SqliteAuthorityDb) {
  db.exec("UPDATE orgs SET kind = 'shared' WHERE kind = 'team'")
}
