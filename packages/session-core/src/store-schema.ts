import { LAUNCH_OWNERSHIP_SCHEMA } from "./ownership/launch-ownership-schema"
import type { SqliteDatabase } from "./sqlite/database"

const SCHEMA: readonly string[] = [
  `CREATE TABLE runtime_journal (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    type TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    provider_session_id TEXT,
    process_key TEXT,
    turn_id TEXT,
    user_message_id TEXT,
    assistant_message_id TEXT,
    part_id TEXT,
    payload_json TEXT NOT NULL,
    source_json TEXT,
    PRIMARY KEY (session_id, seq)
  )`,
  `CREATE INDEX runtime_journal_session_created_idx ON runtime_journal (session_id, created_at, seq)`,
  `CREATE INDEX runtime_journal_message_usage_idx ON runtime_journal (session_id, assistant_message_id, seq)
    WHERE kind = 'event' AND type = 'session.usage'`,
  `CREATE INDEX runtime_journal_part_snapshot_idx ON runtime_journal (session_id, part_id, seq)
    WHERE kind = 'event' AND type = 'message.part.updated' AND part_id IS NOT NULL`,
  // `lastTurn` reads a session's outcome from its newest terminal row on every
  // session read and listing; without this partial index that walks the whole
  // journal backwards. The predicate must stay textually identical to the one
  // in `lastTurn` so the planner can prove the index covers the query.
  `CREATE INDEX runtime_journal_turn_outcome_idx ON runtime_journal (session_id, seq)
    WHERE (kind = 'control' AND type = 'turn.finish')
      OR (kind = 'event' AND type IN ('message.completed', 'session.error'))`,
  `CREATE TABLE session (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    owner_json TEXT NOT NULL,
    directory TEXT NOT NULL,
    title TEXT,
    title_source TEXT,
    agent_session_id TEXT,
    process_key TEXT,
    harness_id TEXT,
    harness_access TEXT,
    harness_binary TEXT,
    harness_transport TEXT,
    harness_url TEXT,
    harness_headers_json TEXT,
    model_provider_id TEXT,
    model_id TEXT,
    variant TEXT,
    agent TEXT,
    instructions TEXT,
    group_json TEXT,
    handoff_json TEXT,
    goal_json TEXT,
    commands_json TEXT,
    permission_mode TEXT,
    permission_mode_label TEXT,
    permission_ceiling TEXT,
    permission_state_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_human_turn_at INTEGER,
    status TEXT,
    recovery_error TEXT,
    archived_at INTEGER
  )`,
  `CREATE INDEX session_parent_idx ON session (parent_id, created_at)`,
  `CREATE TABLE session_turn_lease (
    session_id TEXT PRIMARY KEY,
    lease_id TEXT NOT NULL,
    acquired_at INTEGER NOT NULL
  )`,
  `CREATE TABLE runtime_delivery (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    message_id TEXT,
    parts_json TEXT NOT NULL,
    agent TEXT,
    model_provider_id TEXT,
    model_id TEXT,
    tools_json TEXT,
    format_json TEXT,
    system TEXT,
    variant TEXT,
    permission_mode TEXT,
    delivery TEXT NOT NULL,
    actor_id TEXT,
    actor_kind TEXT,
    author_id TEXT,
    author_name TEXT,
    author_avatar_url TEXT,
    author_kind TEXT,
    queued_at INTEGER NOT NULL,
    steering_json TEXT,
    held INTEGER NOT NULL DEFAULT 0,
    authority_json TEXT,
    origin_provenance TEXT,
    turn_grant TEXT,
    service_tier TEXT,
    PRIMARY KEY (session_id, seq)
  )`,
  // Keeps a session's delivery identities from being reused after its rows are removed.
  `CREATE TABLE runtime_delivery_sequence (
    session_id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL
  )`,
  `CREATE TABLE runtime_secret (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE session_subagent (
    parent_session_id TEXT NOT NULL,
    subagent_key TEXT NOT NULL,
    child_session_id TEXT,
    assistant_message_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    mode TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    label TEXT,
    subagent_type TEXT,
    description TEXT,
    provider_kind TEXT,
    provider_id TEXT,
    transcript_kind TEXT NOT NULL DEFAULT 'none',
    transcript_ref TEXT,
    attention INTEGER,
    run_revision INTEGER,
    origin_provenance TEXT,
    origin_actor_id TEXT,
    origin_actor_kind TEXT,
    origin_user_id TEXT,
    origin_authority_json TEXT,
    wake_grant TEXT,
    mode_revision INTEGER NOT NULL DEFAULT 0,
    status_revision INTEGER NOT NULL DEFAULT 0,
    label_revision INTEGER NOT NULL DEFAULT 0,
    subagent_type_revision INTEGER NOT NULL DEFAULT 0,
    description_revision INTEGER NOT NULL DEFAULT 0,
    provider_kind_revision INTEGER NOT NULL DEFAULT 0,
    provider_id_revision INTEGER NOT NULL DEFAULT 0,
    child_session_id_revision INTEGER NOT NULL DEFAULT 0,
    transcript_revision INTEGER NOT NULL DEFAULT 0,
    attention_revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (parent_session_id, subagent_key)
  )`,
  `CREATE UNIQUE INDEX session_subagent_child_idx ON session_subagent (child_session_id)
    WHERE child_session_id IS NOT NULL`,
  `CREATE UNIQUE INDEX session_subagent_provider_idx ON session_subagent (parent_session_id, provider_kind, provider_id)
    WHERE provider_id IS NOT NULL`,
  `CREATE TABLE session_subagent_tool_call (
    parent_session_id TEXT NOT NULL,
    subagent_key TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('spawn', 'interaction')),
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (parent_session_id, subagent_key, tool_call_id)
  )`,
  `CREATE INDEX session_subagent_tool_call_lookup_idx ON session_subagent_tool_call (parent_session_id, tool_call_id)`,
  `CREATE TABLE session_subagent_observation (
    parent_session_id TEXT NOT NULL,
    observation_id TEXT NOT NULL,
    subagent_key TEXT NOT NULL,
    revision INTEGER NOT NULL,
    observation_json TEXT NOT NULL,
    event_json TEXT NOT NULL,
    published INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (parent_session_id, observation_id)
  )`,
  `CREATE TABLE session_subagent_correlation (
    parent_session_id TEXT NOT NULL,
    correlation_key TEXT NOT NULL,
    subagent_key TEXT NOT NULL,
    run_revision INTEGER,
    PRIMARY KEY (parent_session_id, correlation_key, subagent_key)
  )`,
  // One row per child result the parent is owed. Delivery keeps the row, so
  // the subagent still reads as delivered, and drops the result text.
  `CREATE TABLE session_subagent_wake (
    parent_session_id TEXT NOT NULL,
    observation_id TEXT NOT NULL,
    subagent_key TEXT NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    text TEXT,
    assistant_message_id TEXT,
    delivered INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (parent_session_id, observation_id)
  )`,
  `CREATE INDEX session_subagent_wake_subagent_idx ON session_subagent_wake (parent_session_id, subagent_key, delivered)`,
  `CREATE TABLE session_map (
    session_id TEXT PRIMARY KEY,
    agent_session_id TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE session_execution_binding (
    session_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    directory TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    upstream_session_id TEXT NOT NULL
  )`,
  `CREATE TABLE session_start (
    session_id TEXT PRIMARY KEY,
    directory TEXT NOT NULL,
    data_json TEXT NOT NULL
  )`,
  `CREATE TABLE session_prompt_actor (
    session_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    PRIMARY KEY (session_id, actor_id)
  )`,
  `CREATE TABLE message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    ord INTEGER NOT NULL,
    info_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX message_session_ord_idx ON message (session_id, ord DESC)`,
  `CREATE TABLE part (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    ord INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX part_session_message_ord_idx ON part (session_id, message_id, ord)`,
  `CREATE TABLE todo (
    session_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    task_id TEXT,
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, position)
  )`,
  `CREATE TABLE pending_permission (
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    patterns_json TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    always_json TEXT NOT NULL,
    options_json TEXT,
    broker_request_json TEXT,
    broker_upstream_session_id TEXT,
    broker_start_json TEXT,
    broker_answer_json TEXT,
    broker_automatic INTEGER,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, id)
  )`,
  `CREATE TABLE pending_question (
    id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    questions_json TEXT NOT NULL,
    broker_request_json TEXT,
    broker_upstream_session_id TEXT,
    broker_start_json TEXT,
    broker_answer_json TEXT,
    broker_automatic INTEGER,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, id)
  )`,
  `CREATE TABLE journal_checkpoint (
    session_id TEXT PRIMARY KEY,
    last_seq INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE deleted_session (
    session_id TEXT PRIMARY KEY,
    deleted_at INTEGER NOT NULL
  )`,
  `CREATE TABLE workspace_worktree (
    session_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    path TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL
  )`,
  `CREATE INDEX workspace_worktree_workspace_activity_idx ON workspace_worktree (workspace_id, last_activity_at DESC)`,
  `CREATE TABLE recovery_operation (
    operation_id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    caller_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    session_id TEXT,
    action TEXT NOT NULL,
    state TEXT NOT NULL,
    cleanup_fact TEXT NOT NULL,
    persistence_fact TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL
  )`,
  // Two store handles on one root are two connections, so only SQLite can
  // decide which insert of a repeated request id won.
  `CREATE UNIQUE INDEX recovery_operation_request_idx ON recovery_operation (scope_key, caller_id, request_id)`,
  `CREATE INDEX recovery_operation_session_idx ON recovery_operation (session_id, updated_at DESC)`,
  // Who may read a receipt: its creator plus every caller that coalesced onto
  // it. `recovery_operation.caller_id` stays the single caller that won the
  // insert, because it is a third of the claim key.
  `CREATE TABLE recovery_operation_caller (
    operation_id TEXT NOT NULL,
    caller_id TEXT NOT NULL,
    PRIMARY KEY (operation_id, caller_id)
  )`,
  ...LAUNCH_OWNERSHIP_SCHEMA,
]

/**
 * The schema's identity is its own text, whitespace aside, so no edit to a
 * table can ship without changing it.
 */
const SCHEMA_IDENTITY = SCHEMA.map((statement) => statement.replace(/\s+/g, " ").trim()).join(";\n")

export class RuntimeStoreSchemaMismatchError extends Error {
  readonly code = "runtime_store_schema_mismatch"

  constructor(readonly location: string) {
    super(
      `The runtime store at ${location} was written by a different schema than this build declares. `
        + "It is not migrated: move it aside to start with an empty store.",
    )
    this.name = "RuntimeStoreSchemaMismatchError"
  }
}

/**
 * Declare the schema on an empty database, or refuse one written by any other
 * schema. The check and the creation share one transaction, so two stores
 * opening one empty file cannot both create it.
 */
export function openRuntimeStoreSchema(db: SqliteDatabase, location: string) {
  db.transaction(() => {
    // A Durable Object keeps its own `_cf_` tables in the same database.
    const tables = db
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
      )
      .all()
      .map((row) => row.name)
    if (tables.length === 0) {
      for (const statement of SCHEMA) db.exec(statement)
      db.exec("CREATE TABLE runtime_store_schema (identity TEXT NOT NULL)")
      db.prepare("INSERT INTO runtime_store_schema (identity) VALUES (?)").run(SCHEMA_IDENTITY)
      return
    }
    const recorded = tables.includes("runtime_store_schema")
      ? db.prepare<{ identity: string }>("SELECT identity FROM runtime_store_schema").get()?.identity
      : undefined
    if (recorded !== SCHEMA_IDENTITY) throw new RuntimeStoreSchemaMismatchError(location)
  })
}
