export const LAUNCH_OWNERSHIP_SCHEMA: readonly string[] = [
  `CREATE TABLE launch_ownership (
    launch_id TEXT PRIMARY KEY,
    owner_generation TEXT NOT NULL,
    role TEXT NOT NULL,
    protocol TEXT NOT NULL,
    parent_owner_id TEXT,
    workspace_id TEXT,
    session_id TEXT,
    directory TEXT,
    prepared_at INTEGER NOT NULL,
    identity_json TEXT,
    gate_nonce TEXT,
    identity_received_at INTEGER,
    activation_authorized_at INTEGER,
    activation_acknowledged_at INTEGER,
    retired_at INTEGER,
    cleanup_json TEXT
  )`,
  `CREATE INDEX launch_ownership_unresolved ON launch_ownership (retired_at, workspace_id, owner_generation)`,
]
