CREATE TABLE reports (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  sessions_analyzed INTEGER NOT NULL CHECK (sessions_analyzed >= 0),
  ci_e2e_sessions_excluded INTEGER NOT NULL CHECK (ci_e2e_sessions_excluded >= 0),
  execution_calls INTEGER NOT NULL CHECK (execution_calls >= 0),
  just_bash_percent REAL,
  workerd_percent REAL,
  full_vm_percent REAL,
  median_x_ms REAL,
  p95_x_ms REAL,
  og_png BLOB,
  og_generated_at TEXT
);
