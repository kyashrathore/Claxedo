import { hasColumn, hasTable } from "@claxedo/server-core/platform/db/schema-introspection"
import { addColumn } from "./authority-schema-upgrades"
import type { SqliteAuthorityDb } from "./workspace-authority-store"

const CANONICAL_PRIVATE_SESSIONS_SCHEMA = `
CREATE TABLE session_registration_operations (
  operation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  creator_actor_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  parent_session_id TEXT,
  requested_title TEXT,
  state TEXT NOT NULL,
  state_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE session_history (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  creator_actor_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- NULL means nobody has ever prompted this session. updated_at moves for an
  -- agent's turn too, so the session list cannot band on it.
  last_human_turn_at INTEGER,
  max_event_ordinal INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER
);
CREATE INDEX session_history_by_workspace_updated
  ON session_history (workspace_id, updated_at DESC);
CREATE TABLE session_participants (
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  participant_actor_id TEXT NOT NULL,
  added_by_actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (session_id, participant_actor_id)
);
CREATE INDEX session_participants_by_actor
  ON session_participants (participant_actor_id, revoked_at);
CREATE TABLE session_messages (
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
CREATE TABLE session_turn_leases (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  lease_id TEXT NOT NULL UNIQUE,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  actor_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > acquired_at),
  released_at INTEGER
);
CREATE INDEX session_turn_leases_by_expiry
  ON session_turn_leases (released_at, expires_at, session_id);
CREATE TABLE session_turn_producers (
  session_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  actor_id TEXT NOT NULL,
  admitted_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn_id),
  UNIQUE (session_id, fencing_token)
);`

export function migratePrivateSessionSchema(db: SqliteAuthorityDb) {
  const canonical = hasColumn(db, "session_history", "creator_actor_id")
    && hasColumn(db, "session_history", "operation_id")
  if (canonical) {
    if (!hasTable(db, "session_registration_operations")) {
      throw new Error("private_session_registration_schema_missing")
    }
    ensureSessionTurnSchema(db)
    return
  }

  for (const archive of [
    "legacy_session_history_pre_private_sessions",
    "legacy_session_messages_pre_private_sessions",
    "legacy_session_participants_pre_private_sessions",
  ]) {
    if (hasTable(db, archive)) throw new Error(`private_session_archive_collision:${archive}`)
  }

  // Legacy workspace-visible rows have no canonical registration operation or
  // actor provenance. Preserve them as an operator-inspectable archive, but do
  // not project them into the private-session authority by inventing either.
  db.exec(`
    DROP INDEX IF EXISTS session_history_by_creator;
    DROP INDEX IF EXISTS session_history_by_workspace_creator;
    DROP INDEX IF EXISTS session_participants_by_actor;
    ALTER TABLE session_history RENAME TO legacy_session_history_pre_private_sessions;
    ALTER TABLE session_messages RENAME TO legacy_session_messages_pre_private_sessions;
    ALTER TABLE session_participants RENAME TO legacy_session_participants_pre_private_sessions;
    ${CANONICAL_PRIVATE_SESSIONS_SCHEMA}
  `)
  ensureSessionTurnSchema(db)
}

function ensureSessionTurnSchema(db: SqliteAuthorityDb) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_turn_leases (
      session_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      lease_id TEXT NOT NULL UNIQUE,
      fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
      actor_id TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at > acquired_at),
      released_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS session_turn_leases_by_expiry
      ON session_turn_leases (released_at, expires_at, session_id);
    CREATE TABLE IF NOT EXISTS session_turn_producers (
      session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
      actor_id TEXT NOT NULL,
      admitted_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, turn_id),
      UNIQUE (session_id, fencing_token)
    );
    CREATE TABLE IF NOT EXISTS session_turn_grants (
      grant_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      intent TEXT NOT NULL CHECK (intent IN ('child_completion', 'queued_prompt')),
      subject_session_id TEXT,
      turn_id TEXT,
      turn_id_prefix TEXT,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
      redeemed_at INTEGER,
      redeemed_turn_id TEXT,
      revoked_at INTEGER,
      revoke_reason TEXT,
      CHECK ((turn_id IS NOT NULL) + (turn_id_prefix IS NOT NULL) = 1)
    );
    CREATE INDEX IF NOT EXISTS session_turn_grants_by_session
      ON session_turn_grants (session_id, revoked_at);
    CREATE INDEX IF NOT EXISTS session_turn_grants_by_subject
      ON session_turn_grants (subject_session_id, revoked_at);
  `)
  addColumn(db, "session_history", "snapshot_hash", "TEXT")
  // Not backfilled: a session registered before this column reads as never
  // prompted, which is the only thing the store can honestly say about it.
  addColumn(db, "session_history", "last_human_turn_at", "INTEGER")
  addColumn(db, "session_history", "archived_at", "INTEGER")
  addColumn(db, "session_history", "status", "TEXT")
  addColumn(db, "session_history", "status_at", "INTEGER")
  addColumn(db, "session_history", "awaiting_input", "INTEGER NOT NULL DEFAULT 0")
  addColumn(db, "session_history", "runtime_updated_at", "INTEGER")
  db.exec(`
    CREATE INDEX IF NOT EXISTS session_history_by_workspace_human_turn
      ON session_history (workspace_id, deleted_at, archived_at, last_human_turn_at, created_at);
  `)
}
