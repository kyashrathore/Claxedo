CREATE TABLE reports_v3 (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  schema_version INTEGER NOT NULL CHECK (schema_version IN (2, 3)),
  sessions_analyzed INTEGER NOT NULL CHECK (sessions_analyzed >= 0),
  execution_calls INTEGER NOT NULL CHECK (execution_calls >= 0),
  sessions_without_full_machine_percent REAL,
  turns_analyzed INTEGER NOT NULL CHECK (turns_analyzed >= 0),
  turn_coverage_percent REAL,
  turns_without_full_machine_percent REAL,
  repeat_full_machine_turn_percent REAL,
  full_machine_return_interval_samples INTEGER NOT NULL DEFAULT 0 CHECK (full_machine_return_interval_samples >= 0),
  median_full_machine_return_interval_ms REAL,
  p95_full_machine_return_interval_ms REAL,
  median_calls_after_first_full_machine REAL,
  median_observed_span_after_first_full_machine_ms REAL,
  p95_observed_span_after_first_full_machine_ms REAL,
  og_png BLOB,
  og_generated_at TEXT,
  og_retry_after TEXT
);

INSERT INTO reports_v3 (
  id, created_at, schema_version, sessions_analyzed, execution_calls,
  sessions_without_full_machine_percent, turns_analyzed, turn_coverage_percent,
  turns_without_full_machine_percent, repeat_full_machine_turn_percent,
  full_machine_return_interval_samples, median_full_machine_return_interval_ms,
  p95_full_machine_return_interval_ms, median_calls_after_first_full_machine,
  median_observed_span_after_first_full_machine_ms,
  p95_observed_span_after_first_full_machine_ms, og_png, og_generated_at, og_retry_after
)
SELECT
  id, created_at, schema_version, sessions_analyzed, execution_calls,
  sessions_without_full_machine_percent, turns_analyzed, turn_coverage_percent,
  turns_without_full_machine_percent, repeat_full_machine_turn_percent,
  0, NULL, NULL, median_calls_after_first_full_machine,
  median_observed_span_after_first_full_machine_ms,
  p95_observed_span_after_first_full_machine_ms, og_png, og_generated_at, og_retry_after
FROM reports;

DROP TABLE reports;

ALTER TABLE reports_v3 RENAME TO reports;
