/**
 * Database schema initialization — all CREATE TABLE and migration statements.
 * Call `initializeDb(db)` once at startup before creating any stores or routes.
 */

import { sqlite, type SqliteInput } from "../sqlite";
import { initTriggersTable } from "../triggers/store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureColumn(db: ReturnType<typeof sqlite>, table: string, col: string, sql: string) {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === col)) return;
  db.exec(sql);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function initializeDb(input: SqliteInput) {
  const db = sqlite(input)

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      stream_seq INTEGER NOT NULL,
      logical_ts INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      op_id TEXT NOT NULL UNIQUE,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS runs_current (
      run_id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      status TEXT NOT NULL,
      source_id TEXT,
      runtime_type TEXT NOT NULL DEFAULT 'task',
      runtime_type_reason TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  ensureColumn(db, "runs_current", "source_id", "ALTER TABLE runs_current ADD COLUMN source_id TEXT");
  ensureColumn(db, "runs_current", "runtime_type", "ALTER TABLE runs_current ADD COLUMN runtime_type TEXT NOT NULL DEFAULT 'task'");
  ensureColumn(db, "runs_current", "runtime_type_reason", "ALTER TABLE runs_current ADD COLUMN runtime_type_reason TEXT");
  ensureColumn(db, "runs_current", "created_at", "ALTER TABLE runs_current ADD COLUMN created_at TEXT");
  ensureColumn(db, "runs_current", "updated_at", "ALTER TABLE runs_current ADD COLUMN updated_at TEXT");
  ensureColumn(db, "runs_current", "trigger_id", "ALTER TABLE runs_current ADD COLUMN trigger_id TEXT");
  ensureColumn(db, "runs_current", "trigger_run_index", "ALTER TABLE runs_current ADD COLUMN trigger_run_index INTEGER");
  ensureColumn(db, "runs_current", "metrics_json", "ALTER TABLE runs_current ADD COLUMN metrics_json TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS run_sources_current (
      run_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_path TEXT,
      created_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sources_current (
      source_id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_path TEXT,
      status TEXT NOT NULL,
      plan_run_id TEXT,
      last_run_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, "sources_current", "source_path", "ALTER TABLE sources_current ADD COLUMN source_path TEXT");
  ensureColumn(db, "sources_current", "plan_run_id", "ALTER TABLE sources_current ADD COLUMN plan_run_id TEXT");
  ensureColumn(db, "sources_current", "last_run_id", "ALTER TABLE sources_current ADD COLUMN last_run_id TEXT");
  ensureColumn(db, "sources_current", "error", "ALTER TABLE sources_current ADD COLUMN error TEXT");
  ensureColumn(db, "sources_current", "provider", "ALTER TABLE sources_current ADD COLUMN provider TEXT");
  ensureColumn(db, "sources_current", "provider_connection_id", "ALTER TABLE sources_current ADD COLUMN provider_connection_id TEXT");
  ensureColumn(db, "sources_current", "import_mode", "ALTER TABLE sources_current ADD COLUMN import_mode TEXT");
  ensureColumn(db, "sources_current", "import_query", "ALTER TABLE sources_current ADD COLUMN import_query TEXT");
  ensureColumn(db, "sources_current", "mission_item_id", "ALTER TABLE sources_current ADD COLUMN mission_item_id TEXT");
  ensureColumn(db, "sources_current", "repo_ref", "ALTER TABLE sources_current ADD COLUMN repo_ref TEXT");
  ensureColumn(db, "sources_current", "repo_label", "ALTER TABLE sources_current ADD COLUMN repo_label TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes_current (
      node_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'developer',
      kind TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      node_type TEXT NOT NULL DEFAULT 'task',
      parent_node_id TEXT,
      status TEXT NOT NULL,
      retry_count INTEGER NOT NULL,
      runtime_type TEXT NOT NULL DEFAULT 'task',
      runtime_type_reason TEXT
    );
  `);
  ensureColumn(db, "nodes_current", "node_type", "ALTER TABLE nodes_current ADD COLUMN node_type TEXT NOT NULL DEFAULT 'task'");
  ensureColumn(db, "nodes_current", "parent_node_id", "ALTER TABLE nodes_current ADD COLUMN parent_node_id TEXT");
  ensureColumn(db, "nodes_current", "runtime_type", "ALTER TABLE nodes_current ADD COLUMN runtime_type TEXT NOT NULL DEFAULT 'task'");
  ensureColumn(db, "nodes_current", "runtime_type_reason", "ALTER TABLE nodes_current ADD COLUMN runtime_type_reason TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS dependency_edges_current (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      type TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS scratchpad_entries (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      size_bytes INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS run_exec_current (
      run_id TEXT PRIMARY KEY,
      runtime_type TEXT NOT NULL,
      session_id TEXT,
      pty_id TEXT,
      directory TEXT,
      updated_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS run_node_items_current (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      PRIMARY KEY (run_id, node_id, work_item_id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS run_blockers_current (
      run_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      title TEXT NOT NULL,
      PRIMARY KEY (run_id, work_item_id, target_node_id)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS attempts_current (
      attempt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL,
      runtime_type TEXT NOT NULL,
      directory TEXT,
      worktree_path TEXT,
      session_id TEXT,
      pty_id TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      last_heartbeat_at TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_connections_current (
      connection_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      token TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  initTriggersTable(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS trace_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      run_id TEXT NOT NULL,
      node_id TEXT,
      payload_json TEXT NOT NULL
    );
  `);

  // ---------------------------------------------------------------------------
  // Performance indexes
  // ---------------------------------------------------------------------------

  db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_run_id     ON nodes_current(run_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_run_status ON nodes_current(run_id, status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_run_id     ON dependency_edges_current(run_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_source_id  ON dependency_edges_current(source_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edges_target_id  ON dependency_edges_current(target_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_attempts_run_node ON attempts_current(run_id, node_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_run_node_items_item ON run_node_items_current(work_item_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_run_seq   ON events(run_id, stream_seq)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_active ON nodes_current(run_id) WHERE status NOT IN ('completed', 'cancelled', 'failed')`);
}
