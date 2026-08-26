import { sqlite, type SqliteInput } from "../../sqlite"

const WORKGRAPH_SQLITE_SCHEMA_VERSION = 2
const WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION = 1

// Create-only by design: no ALTER migrations, no upgrade path. Every column
// lives in its CREATE TABLE body; a schema change means deleting the database
// file and letting it recreate. The `user_version` stamp below enforces that
// policy loudly: without it, an older file opens cleanly (every statement is
// CREATE IF NOT EXISTS) and then fails or silently misreads at runtime.
export function initializeWorkGraphSqliteSchema(input: SqliteInput) {
  const db = sqlite(input)
  const { user_version: version } = db.query("PRAGMA user_version").get() as { user_version: number }
  if (version !== WORKGRAPH_SQLITE_SCHEMA_VERSION) {
    const existing = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wg_v2_%' LIMIT 1")
      .get() as { name: string } | undefined
    if (existing) {
      throw new Error(
        `WorkGraph SQLite database predates the current create-only schema (found ${existing.name} at user_version ${version}); delete the database file and let it recreate`,
      )
    }
  }
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS wg_v2_workgraphs (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      defaults_json TEXT NOT NULL DEFAULT '{}',
      recap_defaults_json TEXT NOT NULL DEFAULT '{}',
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id)
    );

    CREATE TABLE IF NOT EXISTS wg_v2_work_sources (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      workgraph_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source_kind TEXT NOT NULL DEFAULT 'manual',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      latest_revision_number INTEGER NOT NULL DEFAULT 0,
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      FOREIGN KEY (organization_id, owner_user_id, workgraph_id) REFERENCES wg_v2_workgraphs(organization_id, owner_user_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wg_v2_work_source_revisions (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      work_source_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      origin_kind TEXT NOT NULL DEFAULT 'manual',
      origin_reference_json TEXT,
      created_by_json TEXT,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, work_source_id, revision_number),
      UNIQUE (organization_id, owner_user_id, work_source_id, id),
      FOREIGN KEY (organization_id, owner_user_id, work_source_id) REFERENCES wg_v2_work_sources(organization_id, owner_user_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wg_v2_source_views (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      workgraph_id TEXT NOT NULL,
      team_connection_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      filters_json TEXT NOT NULL,
      target_json TEXT,
      refresh_policy_json TEXT NOT NULL DEFAULT '{}',
      sync_policy TEXT NOT NULL DEFAULT 'announce',
      status TEXT NOT NULL DEFAULT 'active',
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      FOREIGN KEY (organization_id, owner_user_id, workgraph_id) REFERENCES wg_v2_workgraphs(organization_id, owner_user_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wg_v2_webhook_deliveries (
      organization_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      claimed_by TEXT,
      claim_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, connection_id, provider, delivery_id)
    );

    CREATE TABLE IF NOT EXISTS wg_v2_intake_candidates (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      workgraph_id TEXT NOT NULL,
      source_view_id TEXT,
      candidate_kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      normalized_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'unorganized',
      observed_revision TEXT,
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      FOREIGN KEY (organization_id, owner_user_id, workgraph_id) REFERENCES wg_v2_workgraphs(organization_id, owner_user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, owner_user_id, source_view_id) REFERENCES wg_v2_source_views(organization_id, owner_user_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS wg_v2_external_identities (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      intake_candidate_id TEXT,
      provider TEXT NOT NULL,
      team_connection_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      external_key TEXT,
      external_url TEXT,
      observed_revision TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, provider, team_connection_id, external_id),
      FOREIGN KEY (organization_id, owner_user_id, intake_candidate_id) REFERENCES wg_v2_intake_candidates(organization_id, owner_user_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS wg_v2_streams (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      workgraph_id TEXT NOT NULL,
      parent_stream_id TEXT,
      title TEXT NOT NULL,
      purpose TEXT NOT NULL,
      charter_json TEXT,
      master_status_json TEXT,
      notes_source_json TEXT,
      public_pr_confirmed_at TEXT,
      stream_kind TEXT NOT NULL DEFAULT 'finite',
      lifecycle TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'visible',
      pinned INTEGER NOT NULL DEFAULT 0,
      execution_defaults_json TEXT NOT NULL DEFAULT '{}',
      spend_json TEXT,
      recap_defaults_json TEXT NOT NULL DEFAULT '{}',
      activity_granularity TEXT NOT NULL DEFAULT 'progress' CHECK (activity_granularity IN ('milestones', 'progress', 'detailed')),
      memory_card_json TEXT NOT NULL DEFAULT '{}',
      base_repository TEXT,
      base_revision TEXT,
      envelope_intent_json TEXT NOT NULL DEFAULT '{}',
      envelope_identity_json TEXT,
      replacement_reset_json TEXT,
      last_activity_at TEXT,
      quiet_since TEXT,
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      PRIMARY KEY (organization_id, owner_user_id, id),
      FOREIGN KEY (organization_id, owner_user_id, workgraph_id) REFERENCES wg_v2_workgraphs(organization_id, owner_user_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wg_v2_llm_usage_events (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      stream_id TEXT,
      run_id TEXT,
      work_item_id TEXT,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      PRIMARY KEY (organization_id, owner_user_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_wg_v2_usage_stream_created
      ON wg_v2_llm_usage_events(organization_id, owner_user_id, stream_id, created_at, id);

    CREATE TABLE IF NOT EXISTS wg_v2_outcomes (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      lifecycle TEXT NOT NULL,
      success_criteria_json TEXT NOT NULL,
      execution_defaults_json TEXT NOT NULL DEFAULT '{}',
      ready_to_close_at TEXT,
      completed_at TEXT,
      closed_by_json TEXT,
      close_reason TEXT,
      reopened_at TEXT,
      reopen_reason TEXT,
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, stream_id, id),
      FOREIGN KEY (organization_id, owner_user_id, stream_id) REFERENCES wg_v2_streams(organization_id, owner_user_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wg_v2_work_items (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      parent_task_id TEXT,
      outcome_id TEXT,
      source_revision_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      lifecycle TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      execution_overrides_json TEXT NOT NULL DEFAULT '{}',
      completion_contract_json TEXT NOT NULL DEFAULT '{}',
      created_by_actor_type TEXT,
      created_by_actor_id TEXT,
      origin_run_id TEXT,
      auto_admitted INTEGER CHECK (auto_admitted IN (0, 1)),
      abandoned_reason TEXT,
      abandoned_at TEXT,
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, stream_id, id),
      FOREIGN KEY (organization_id, owner_user_id, stream_id) REFERENCES wg_v2_streams(organization_id, owner_user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, owner_user_id, stream_id, outcome_id) REFERENCES wg_v2_outcomes(organization_id, owner_user_id, stream_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, owner_user_id, source_revision_id) REFERENCES wg_v2_work_source_revisions(organization_id, owner_user_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS wg_v2_work_item_dependencies (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      depends_on_work_item_id TEXT NOT NULL,
      dependency_kind TEXT NOT NULL DEFAULT 'blocks',
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, work_item_id, depends_on_work_item_id),
      CHECK (work_item_id <> depends_on_work_item_id),
      FOREIGN KEY (organization_id, owner_user_id, work_item_id) REFERENCES wg_v2_work_items(organization_id, owner_user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, owner_user_id, depends_on_work_item_id) REFERENCES wg_v2_work_items(organization_id, owner_user_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wg_v2_runs (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      run_number INTEGER NOT NULL,
      lifecycle TEXT NOT NULL,
      execution_kind TEXT NOT NULL DEFAULT 'managed' CHECK (execution_kind IN ('managed', 'attached')),
      resolved_execution_profile_json TEXT NOT NULL,
      envelope_id TEXT,
      child_workspace_id TEXT,
      session_id TEXT,
      terminal_result_json TEXT,
      parked_reason TEXT,
      resume_attempts INTEGER NOT NULL DEFAULT 0,
      resume_available_at TEXT,
      completion_retry_json TEXT,
      generation INTEGER NOT NULL DEFAULT 1,
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, work_item_id, run_number),
      FOREIGN KEY (organization_id, owner_user_id, stream_id) REFERENCES wg_v2_streams(organization_id, owner_user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, owner_user_id, stream_id, work_item_id) REFERENCES wg_v2_work_items(organization_id, owner_user_id, stream_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wg_v2_session_bindings (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      current_work_item_id TEXT,
      current_run_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('active', 'released')),
      bound_at TEXT NOT NULL,
      released_at TEXT,
      provenance_json TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      FOREIGN KEY (organization_id, owner_user_id, stream_id) REFERENCES wg_v2_streams(organization_id, owner_user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, owner_user_id, stream_id, current_work_item_id) REFERENCES wg_v2_work_items(organization_id, owner_user_id, stream_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (organization_id, owner_user_id, current_run_id) REFERENCES wg_v2_runs(organization_id, owner_user_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS wg_v2_agent_checkpoints (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      session_binding_id TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('milestone', 'progress', 'detail')),
      summary TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      occurred_at TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, operation_id),
      FOREIGN KEY (organization_id, owner_user_id, stream_id, work_item_id) REFERENCES wg_v2_work_items(organization_id, owner_user_id, stream_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, owner_user_id, run_id) REFERENCES wg_v2_runs(organization_id, owner_user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, owner_user_id, session_binding_id) REFERENCES wg_v2_session_bindings(organization_id, owner_user_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wg_v2_leases (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      holder_id TEXT NOT NULL,
      epoch INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, resource_type, resource_id)
    );

    CREATE TABLE IF NOT EXISTS wg_v2_runtime_effects (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      effect_kind TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS wg_v2_stream_cleanup_reservations (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      expected_version INTEGER NOT NULL,
      cleanup_mode TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'reserved',
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, stream_id),
      UNIQUE (organization_id, owner_user_id, operation_id),
      FOREIGN KEY (organization_id, owner_user_id, stream_id) REFERENCES wg_v2_streams(organization_id, owner_user_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wg_v2_decisions (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL,
      recommendation_json TEXT,
      rationale TEXT,
      answer_json TEXT,
      lifecycle TEXT NOT NULL,
      proposed_by_json TEXT NOT NULL,
      answered_by_json TEXT,
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      answered_at TEXT,
      PRIMARY KEY (organization_id, owner_user_id, id),
      FOREIGN KEY (organization_id, owner_user_id, stream_id) REFERENCES wg_v2_streams(organization_id, owner_user_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wg_v2_decision_work_items (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      decision_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, decision_id, work_item_id),
      FOREIGN KEY (organization_id, owner_user_id, decision_id) REFERENCES wg_v2_decisions(organization_id, owner_user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, owner_user_id, work_item_id) REFERENCES wg_v2_work_items(organization_id, owner_user_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wg_v2_evidence (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      requirement_id TEXT,
      source_run_id TEXT,
      evidence_kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      reference_json TEXT NOT NULL DEFAULT '{}',
      provenance_json TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      FOREIGN KEY (organization_id, owner_user_id, stream_id) REFERENCES wg_v2_streams(organization_id, owner_user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, owner_user_id, source_run_id) REFERENCES wg_v2_runs(organization_id, owner_user_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS wg_v2_durable_effect_receipts (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      run_id TEXT,
      effect_kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      external_reference_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, idempotency_key),
      FOREIGN KEY (organization_id, owner_user_id, stream_id) REFERENCES wg_v2_streams(organization_id, owner_user_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (organization_id, owner_user_id, run_id) REFERENCES wg_v2_runs(organization_id, owner_user_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS wg_v2_attention_acknowledgements (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      read_through_at INTEGER NOT NULL,
      cleared_through_at INTEGER,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      PRIMARY KEY (organization_id, owner_user_id)
    );

    CREATE TABLE IF NOT EXISTS wg_v2_record_source_revisions (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      record_type TEXT NOT NULL,
      record_id TEXT NOT NULL,
      work_source_id TEXT NOT NULL,
      source_revision_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL DEFAULT 0,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, record_type, record_id, source_revision_id),
      UNIQUE (organization_id, owner_user_id, record_type, record_id, ordinal),
      CHECK (ordinal >= 0),
      FOREIGN KEY (organization_id, owner_user_id, work_source_id, source_revision_id) REFERENCES wg_v2_work_source_revisions(organization_id, owner_user_id, work_source_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS wg_v2_admission_proposals (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      workgraph_id TEXT NOT NULL,
      source_revision_id TEXT,
      previous_source_revision_id TEXT,
      intake_candidate_id TEXT,
      proposal_kind TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      proposed_work_json TEXT NOT NULL,
      duplicate_matches_json TEXT NOT NULL DEFAULT '[]',
      disposition_json TEXT,
      confirmed_change_cursor INTEGER,
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      confirmed_at TEXT,
      PRIMARY KEY (organization_id, owner_user_id, id),
      FOREIGN KEY (organization_id, owner_user_id, workgraph_id) REFERENCES wg_v2_workgraphs(organization_id, owner_user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, owner_user_id, source_revision_id) REFERENCES wg_v2_work_source_revisions(organization_id, owner_user_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (organization_id, owner_user_id, previous_source_revision_id) REFERENCES wg_v2_work_source_revisions(organization_id, owner_user_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (organization_id, owner_user_id, intake_candidate_id) REFERENCES wg_v2_intake_candidates(organization_id, owner_user_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS wg_v2_operation_results (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      command_type TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_status INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      change_cursor INTEGER,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id)
    );

    CREATE TABLE IF NOT EXISTS wg_v2_stream_sequences (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      next_sequence INTEGER NOT NULL DEFAULT 1,
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, stream_id),
      CHECK (next_sequence >= 1)
    );

    CREATE TABLE IF NOT EXISTS wg_v2_change_cursors (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      next_cursor INTEGER NOT NULL DEFAULT 1,
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id),
      CHECK (next_cursor >= 1)
    );

    CREATE TABLE IF NOT EXISTS wg_v2_events (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      stream_id TEXT,
      sequence INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      operation_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      correlation_id TEXT,
      causation_id TEXT,
      occurred_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, stream_id, sequence),
      FOREIGN KEY (organization_id, owner_user_id, operation_id) REFERENCES wg_v2_operation_results(organization_id, owner_user_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS wg_v2_changes (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      cursor INTEGER NOT NULL,
      id TEXT NOT NULL,
      stream_id TEXT,
      operation_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      snapshot_relevant INTEGER NOT NULL DEFAULT 1 CHECK (snapshot_relevant IN (0, 1)),
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, cursor),
      UNIQUE (organization_id, owner_user_id, id),
      FOREIGN KEY (organization_id, owner_user_id, operation_id) REFERENCES wg_v2_operation_results(organization_id, owner_user_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS wg_v2_outbox (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      effect_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      available_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      claimed_by TEXT,
      claim_expires_at TEXT,
      last_error TEXT,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, idempotency_key),
      FOREIGN KEY (organization_id, owner_user_id, operation_id) REFERENCES wg_v2_operation_results(organization_id, owner_user_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS wg_v2_due_jobs (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      stream_id TEXT,
      job_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      payload_json TEXT NOT NULL DEFAULT '{}',
      lease_epoch INTEGER NOT NULL DEFAULT 0,
      claimed_by TEXT,
      claim_expires_at TEXT,
      last_error TEXT,
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, job_type, subject_id),
      FOREIGN KEY (organization_id, owner_user_id, stream_id) REFERENCES wg_v2_streams(organization_id, owner_user_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wg_v2_master_mailbox (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      id TEXT NOT NULL,
      message TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'consumed')),
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      FOREIGN KEY (organization_id, owner_user_id, stream_id) REFERENCES wg_v2_streams(organization_id, owner_user_id, id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS wg_v2_migration_intake (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      legacy_table TEXT NOT NULL,
      legacy_record_id TEXT NOT NULL,
      intake_kind TEXT NOT NULL,
      reason TEXT NOT NULL,
      raw_reference_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_review',
      resolution_json TEXT,
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, legacy_table, legacy_record_id)
    );

    CREATE TABLE IF NOT EXISTS wg_v2_archive_restores (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      archive_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, operation_id)
    );

    -- Control-plane receipt only: it retains no owner identifier or WorkGraph content.
    CREATE TABLE IF NOT EXISTS wg_owner_deletion_receipts (
      owner_subject_hash TEXT NOT NULL,
      operation_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      target_snapshot_hash TEXT NOT NULL,
      result_json TEXT,
      lease_expires_at INTEGER NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_SCHEMA_VERSION},
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_subject_hash, operation_hash)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS wg_owner_deletion_active_idx
      ON wg_owner_deletion_receipts (owner_subject_hash) WHERE state = 'cleaning';

    CREATE INDEX IF NOT EXISTS wg_v2_work_sources_workgraph_idx ON wg_v2_work_sources(organization_id, owner_user_id, workgraph_id, updated_at);
    CREATE INDEX IF NOT EXISTS wg_v2_source_revisions_source_idx ON wg_v2_work_source_revisions(organization_id, owner_user_id, work_source_id, revision_number);
    CREATE INDEX IF NOT EXISTS wg_v2_source_views_provider_idx ON wg_v2_source_views(organization_id, owner_user_id, provider, status);
    CREATE INDEX IF NOT EXISTS wg_v2_intake_status_idx ON wg_v2_intake_candidates(organization_id, owner_user_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS wg_v2_external_identity_lookup_idx ON wg_v2_external_identities(organization_id, owner_user_id, provider, team_connection_id, external_id);
    CREATE INDEX IF NOT EXISTS wg_v2_streams_lifecycle_idx ON wg_v2_streams(organization_id, owner_user_id, lifecycle, pinned, updated_at);
    CREATE INDEX IF NOT EXISTS wg_v2_streams_parent_idx ON wg_v2_streams(organization_id, owner_user_id, parent_stream_id);
    CREATE INDEX IF NOT EXISTS wg_v2_outcomes_stream_idx ON wg_v2_outcomes(organization_id, owner_user_id, stream_id, lifecycle, updated_at);
    CREATE INDEX IF NOT EXISTS wg_v2_work_items_outcome_idx ON wg_v2_work_items(organization_id, owner_user_id, outcome_id, lifecycle, priority);
    CREATE INDEX IF NOT EXISTS wg_v2_work_items_stream_idx ON wg_v2_work_items(organization_id, owner_user_id, stream_id, lifecycle, updated_at);
    CREATE INDEX IF NOT EXISTS wg_v2_work_items_parent_idx ON wg_v2_work_items(organization_id, owner_user_id, parent_task_id);
    CREATE INDEX IF NOT EXISTS wg_v2_dependencies_item_idx ON wg_v2_work_item_dependencies(organization_id, owner_user_id, work_item_id);
    CREATE INDEX IF NOT EXISTS wg_v2_dependencies_target_idx ON wg_v2_work_item_dependencies(organization_id, owner_user_id, depends_on_work_item_id);
    CREATE INDEX IF NOT EXISTS wg_v2_runs_item_idx ON wg_v2_runs(organization_id, owner_user_id, work_item_id, run_number);
    CREATE INDEX IF NOT EXISTS wg_v2_runs_stream_state_idx ON wg_v2_runs(organization_id, owner_user_id, stream_id, lifecycle, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS wg_v2_session_bindings_active_session_idx
      ON wg_v2_session_bindings(organization_id, owner_user_id, session_id) WHERE state = 'active';
    CREATE INDEX IF NOT EXISTS wg_v2_session_bindings_stream_idx ON wg_v2_session_bindings(organization_id, owner_user_id, stream_id, updated_at);
    CREATE INDEX IF NOT EXISTS wg_v2_agent_checkpoints_item_idx ON wg_v2_agent_checkpoints(organization_id, owner_user_id, work_item_id, occurred_at, id);
    CREATE INDEX IF NOT EXISTS wg_v2_leases_expiry_idx ON wg_v2_leases(organization_id, owner_user_id, expires_at);
    CREATE INDEX IF NOT EXISTS wg_v2_decisions_stream_state_idx ON wg_v2_decisions(organization_id, owner_user_id, stream_id, lifecycle, updated_at);
    CREATE INDEX IF NOT EXISTS wg_v2_decision_items_item_idx ON wg_v2_decision_work_items(organization_id, owner_user_id, work_item_id);
    CREATE INDEX IF NOT EXISTS wg_v2_evidence_subject_idx ON wg_v2_evidence(organization_id, owner_user_id, subject_type, subject_id, requirement_id, created_at);
    CREATE INDEX IF NOT EXISTS wg_v2_evidence_subject_created_id_idx ON wg_v2_evidence(organization_id, owner_user_id, subject_type, subject_id, created_at, id);
    CREATE INDEX IF NOT EXISTS wg_v2_evidence_run_idx ON wg_v2_evidence(organization_id, owner_user_id, source_run_id, created_at);
    CREATE INDEX IF NOT EXISTS wg_v2_receipts_stream_idx ON wg_v2_durable_effect_receipts(organization_id, owner_user_id, stream_id, created_at);
    CREATE INDEX IF NOT EXISTS wg_v2_record_source_revisions_record_idx ON wg_v2_record_source_revisions(organization_id, owner_user_id, record_type, record_id, ordinal);
    CREATE INDEX IF NOT EXISTS wg_v2_proposals_state_idx ON wg_v2_admission_proposals(organization_id, owner_user_id, lifecycle, updated_at);
    CREATE INDEX IF NOT EXISTS wg_v2_proposals_source_idx ON wg_v2_admission_proposals(organization_id, owner_user_id, source_revision_id);
    CREATE INDEX IF NOT EXISTS wg_v2_events_stream_sequence_idx ON wg_v2_events(organization_id, owner_user_id, stream_id, sequence);
    CREATE INDEX IF NOT EXISTS wg_v2_events_operation_idx ON wg_v2_events(organization_id, owner_user_id, operation_id);
    CREATE INDEX IF NOT EXISTS wg_v2_changes_resource_idx ON wg_v2_changes(organization_id, owner_user_id, resource_type, resource_id, cursor);
    CREATE INDEX IF NOT EXISTS wg_v2_changes_stream_idx ON wg_v2_changes(organization_id, owner_user_id, stream_id, cursor);
    CREATE INDEX IF NOT EXISTS wg_v2_outbox_due_idx ON wg_v2_outbox(organization_id, owner_user_id, status, available_at);
    CREATE INDEX IF NOT EXISTS wg_v2_due_jobs_due_idx ON wg_v2_due_jobs(organization_id, owner_user_id, status, due_at);
    CREATE INDEX IF NOT EXISTS wg_v2_master_mailbox_pending_idx ON wg_v2_master_mailbox(organization_id, owner_user_id, stream_id, status, created_at);
    CREATE INDEX IF NOT EXISTS wg_v2_migration_intake_status_idx ON wg_v2_migration_intake(organization_id, owner_user_id, status, created_at);
    CREATE INDEX IF NOT EXISTS wg_v2_changes_snapshot_relevant_idx ON wg_v2_changes(organization_id, owner_user_id, snapshot_relevant, cursor);

    PRAGMA user_version = ${WORKGRAPH_SQLITE_SCHEMA_VERSION};
  `)

  return db
}
