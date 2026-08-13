CREATE TABLE reports_without_ci_e2e (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  sessions_analyzed INTEGER NOT NULL CHECK (sessions_analyzed >= 0),
  execution_calls INTEGER NOT NULL CHECK (execution_calls >= 0),
  just_bash_percent REAL,
  workerd_percent REAL,
  full_vm_percent REAL,
  median_x_ms REAL,
  p95_x_ms REAL,
  og_png BLOB,
  og_generated_at TEXT
);

INSERT INTO reports_without_ci_e2e (
  id,
  created_at,
  schema_version,
  sessions_analyzed,
  execution_calls,
  just_bash_percent,
  workerd_percent,
  full_vm_percent,
  median_x_ms,
  p95_x_ms,
  og_png,
  og_generated_at
)
SELECT
  id,
  created_at,
  schema_version,
  sessions_analyzed,
  execution_calls,
  just_bash_percent,
  workerd_percent,
  full_vm_percent,
  median_x_ms,
  p95_x_ms,
  og_png,
  og_generated_at
FROM reports;

DROP TABLE reports;

ALTER TABLE reports_without_ci_e2e RENAME TO reports;
