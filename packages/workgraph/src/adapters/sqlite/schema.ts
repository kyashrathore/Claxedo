import { createHash } from "node:crypto"
import { sqlite, type SqliteInput } from "../../sqlite"
import { AdmissionAgentPlanSchema, createChangeCursor } from "../../contracts"

export const WORKGRAPH_SQLITE_SCHEMA_VERSION = 2
const WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION = 1

export function initializeWorkGraphSqliteSchema(input: SqliteInput) {
  const db = sqlite(input)
  rejectAmbiguousOwnerOnlySchema(db)
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
      created_at TEXT NOT NULL,
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
      created_at TEXT NOT NULL,
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
      title TEXT NOT NULL,
      purpose TEXT NOT NULL,
      stream_kind TEXT NOT NULL DEFAULT 'finite',
      lifecycle TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'visible',
      pinned INTEGER NOT NULL DEFAULT 0,
      execution_mode TEXT CHECK (execution_mode IS NULL OR execution_mode IN ('autonomous', 'supervised')),
      execution_state TEXT CHECK (execution_state IS NULL OR execution_state IN ('active', 'stopped', 'completed')),
      execution_defaults_json TEXT NOT NULL DEFAULT '{}',
      recap_defaults_json TEXT NOT NULL DEFAULT '{}',
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
      outcome_id TEXT,
      source_revision_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      lifecycle TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      execution_overrides_json TEXT NOT NULL DEFAULT '{}',
      completion_contract_json TEXT NOT NULL DEFAULT '{}',
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

    CREATE TABLE IF NOT EXISTS wg_v2_attempts (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      lifecycle TEXT NOT NULL,
      execution_mode TEXT CHECK (execution_mode IS NULL OR execution_mode IN ('autonomous', 'supervised')),
      resolved_execution_profile_json TEXT NOT NULL,
      envelope_id TEXT,
      child_workspace_id TEXT,
      session_id TEXT,
      terminal_result_json TEXT,
      attention_reason TEXT,
      lease_epoch INTEGER NOT NULL DEFAULT 1,
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, work_item_id, attempt_number),
      FOREIGN KEY (organization_id, owner_user_id, stream_id) REFERENCES wg_v2_streams(organization_id, owner_user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, owner_user_id, stream_id, work_item_id) REFERENCES wg_v2_work_items(organization_id, owner_user_id, stream_id, id) ON DELETE CASCADE
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
      source_attempt_id TEXT,
      evidence_kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      reference_json TEXT NOT NULL DEFAULT '{}',
      provenance_json TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      FOREIGN KEY (organization_id, owner_user_id, stream_id) REFERENCES wg_v2_streams(organization_id, owner_user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, owner_user_id, source_attempt_id) REFERENCES wg_v2_attempts(organization_id, owner_user_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS wg_v2_durable_effect_receipts (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      attempt_id TEXT,
      effect_kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      external_reference_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, idempotency_key),
      FOREIGN KEY (organization_id, owner_user_id, stream_id) REFERENCES wg_v2_streams(organization_id, owner_user_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (organization_id, owner_user_id, attempt_id) REFERENCES wg_v2_attempts(organization_id, owner_user_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS wg_v2_recaps (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      previous_recap_id TEXT,
      activity_start_sequence INTEGER NOT NULL,
      activity_end_sequence INTEGER NOT NULL,
      quiet_since TEXT NOT NULL,
      summary TEXT NOT NULL,
      actionable_references_json TEXT NOT NULL DEFAULT '[]',
      generation_profile_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      generation_result_json TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, stream_id, activity_end_sequence),
      CHECK (activity_end_sequence >= activity_start_sequence),
      FOREIGN KEY (organization_id, owner_user_id, stream_id) REFERENCES wg_v2_streams(organization_id, owner_user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, owner_user_id, previous_recap_id) REFERENCES wg_v2_recaps(organization_id, owner_user_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS wg_v2_notifications (
      organization_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      notification_kind TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'unread',
      stream_id TEXT NOT NULL,
      recap_id TEXT NOT NULL,
      row_version INTEGER NOT NULL DEFAULT 1,
      schema_version INTEGER NOT NULL DEFAULT ${WORKGRAPH_SQLITE_RECORD_SCHEMA_VERSION},
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      read_at TEXT,
      PRIMARY KEY (organization_id, owner_user_id, id),
      UNIQUE (organization_id, owner_user_id, recap_id),
      FOREIGN KEY (organization_id, owner_user_id, stream_id) REFERENCES wg_v2_streams(organization_id, owner_user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, owner_user_id, recap_id) REFERENCES wg_v2_recaps(organization_id, owner_user_id, id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS wg_v2_notifications_by_owner_state_updated
      ON wg_v2_notifications (organization_id, owner_user_id, state, updated_at, id);

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
    CREATE INDEX IF NOT EXISTS wg_v2_outcomes_stream_idx ON wg_v2_outcomes(organization_id, owner_user_id, stream_id, lifecycle, updated_at);
    CREATE INDEX IF NOT EXISTS wg_v2_work_items_outcome_idx ON wg_v2_work_items(organization_id, owner_user_id, outcome_id, lifecycle, priority);
    CREATE INDEX IF NOT EXISTS wg_v2_work_items_stream_idx ON wg_v2_work_items(organization_id, owner_user_id, stream_id, lifecycle, updated_at);
    CREATE INDEX IF NOT EXISTS wg_v2_dependencies_item_idx ON wg_v2_work_item_dependencies(organization_id, owner_user_id, work_item_id);
    CREATE INDEX IF NOT EXISTS wg_v2_dependencies_target_idx ON wg_v2_work_item_dependencies(organization_id, owner_user_id, depends_on_work_item_id);
    CREATE INDEX IF NOT EXISTS wg_v2_attempts_item_idx ON wg_v2_attempts(organization_id, owner_user_id, work_item_id, attempt_number);
    CREATE INDEX IF NOT EXISTS wg_v2_attempts_stream_state_idx ON wg_v2_attempts(organization_id, owner_user_id, stream_id, lifecycle, updated_at);
    CREATE INDEX IF NOT EXISTS wg_v2_leases_expiry_idx ON wg_v2_leases(organization_id, owner_user_id, expires_at);
    CREATE INDEX IF NOT EXISTS wg_v2_decisions_stream_state_idx ON wg_v2_decisions(organization_id, owner_user_id, stream_id, lifecycle, updated_at);
    CREATE INDEX IF NOT EXISTS wg_v2_decision_items_item_idx ON wg_v2_decision_work_items(organization_id, owner_user_id, work_item_id);
    CREATE INDEX IF NOT EXISTS wg_v2_evidence_subject_idx ON wg_v2_evidence(organization_id, owner_user_id, subject_type, subject_id, requirement_id, created_at);
    CREATE INDEX IF NOT EXISTS wg_v2_evidence_subject_created_id_idx ON wg_v2_evidence(organization_id, owner_user_id, subject_type, subject_id, created_at, id);
    CREATE INDEX IF NOT EXISTS wg_v2_evidence_attempt_idx ON wg_v2_evidence(organization_id, owner_user_id, source_attempt_id, created_at);
    CREATE INDEX IF NOT EXISTS wg_v2_receipts_stream_idx ON wg_v2_durable_effect_receipts(organization_id, owner_user_id, stream_id, created_at);
    CREATE INDEX IF NOT EXISTS wg_v2_recaps_stream_idx ON wg_v2_recaps(organization_id, owner_user_id, stream_id, activity_end_sequence);
    CREATE INDEX IF NOT EXISTS wg_v2_record_source_revisions_record_idx ON wg_v2_record_source_revisions(organization_id, owner_user_id, record_type, record_id, ordinal);
    CREATE INDEX IF NOT EXISTS wg_v2_proposals_state_idx ON wg_v2_admission_proposals(organization_id, owner_user_id, lifecycle, updated_at);
    CREATE INDEX IF NOT EXISTS wg_v2_proposals_source_idx ON wg_v2_admission_proposals(organization_id, owner_user_id, source_revision_id);
    CREATE INDEX IF NOT EXISTS wg_v2_events_stream_sequence_idx ON wg_v2_events(organization_id, owner_user_id, stream_id, sequence);
    CREATE INDEX IF NOT EXISTS wg_v2_events_operation_idx ON wg_v2_events(organization_id, owner_user_id, operation_id);
    CREATE INDEX IF NOT EXISTS wg_v2_changes_resource_idx ON wg_v2_changes(organization_id, owner_user_id, resource_type, resource_id, cursor);
    CREATE INDEX IF NOT EXISTS wg_v2_changes_stream_idx ON wg_v2_changes(organization_id, owner_user_id, stream_id, cursor);
    CREATE INDEX IF NOT EXISTS wg_v2_outbox_due_idx ON wg_v2_outbox(organization_id, owner_user_id, status, available_at);
    CREATE INDEX IF NOT EXISTS wg_v2_due_jobs_due_idx ON wg_v2_due_jobs(organization_id, owner_user_id, status, due_at);
    CREATE INDEX IF NOT EXISTS wg_v2_migration_intake_status_idx ON wg_v2_migration_intake(organization_id, owner_user_id, status, created_at);
  `)

  const attemptColumns = db.query("PRAGMA table_info(wg_v2_attempts)").all() as Array<{ name: string }>
  if (!attemptColumns.some((column) => column.name === "lease_epoch")) {
    db.exec("ALTER TABLE wg_v2_attempts ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 1")
  }
  if (!attemptColumns.some((column) => column.name === "execution_mode")) {
    db.exec("ALTER TABLE wg_v2_attempts ADD COLUMN execution_mode TEXT")
  }

  const sourceRevisionColumns = db.query("PRAGMA table_info(wg_v2_work_source_revisions)").all() as Array<{ name: string }>
  if (!sourceRevisionColumns.some((column) => column.name === "created_by_json")) {
    db.exec("ALTER TABLE wg_v2_work_source_revisions ADD COLUMN created_by_json TEXT")
  }

  const recapColumns = db.query("PRAGMA table_info(wg_v2_recaps)").all() as Array<{ name: string }>
  if (!recapColumns.some((column) => column.name === "quiet_since")) {
    db.exec("ALTER TABLE wg_v2_recaps ADD COLUMN quiet_since TEXT NOT NULL DEFAULT '0'")
  }

  const streamColumns = db.query("PRAGMA table_info(wg_v2_streams)").all() as Array<{ name: string }>
  if (!streamColumns.some((column) => column.name === "replacement_reset_json")) {
    db.exec("ALTER TABLE wg_v2_streams ADD COLUMN replacement_reset_json TEXT")
  }
  if (!streamColumns.some((column) => column.name === "execution_mode")) {
    db.exec("ALTER TABLE wg_v2_streams ADD COLUMN execution_mode TEXT")
  }
  if (!streamColumns.some((column) => column.name === "execution_state")) {
    db.exec("ALTER TABLE wg_v2_streams ADD COLUMN execution_state TEXT")
  }
  db.exec(`
    DROP INDEX IF EXISTS wg_v2_streams_execution_idx;
    CREATE INDEX wg_v2_streams_execution_idx
      ON wg_v2_streams(organization_id, owner_user_id, execution_state, updated_at);
  `)

  invalidateLegacyAdmissionFallbacks(db)
  repairLegacySourcePlanPublications(db)

  return db
}

function rejectAmbiguousOwnerOnlySchema(db: ReturnType<typeof sqlite>) {
  const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wg_v2_%'").all() as Array<{ name: string }>
  const ambiguous = tables.find((table) => {
    if (table.name === "wg_v2_webhook_deliveries") return !hasColumn(db, table.name, "organization_id")
    const columns = db.query(`PRAGMA table_info(${table.name})`).all() as Array<{ name: string }>
    return columns.some((column) => column.name === "owner_user_id") && !columns.some((column) => column.name === "organization_id")
  })
  if (ambiguous) {
    throw new Error(`WorkGraph SQLite schema ${ambiguous.name} has owner-only tenancy; a trusted organization mapping is required before migration`)
  }
  const receiptTable = db.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'wg_owner_deletion_receipts'").get()
  if (!receiptTable) return
  if (!hasColumn(db, "wg_owner_deletion_receipts", "schema_version") ||
    db.query(`SELECT 1 AS present FROM wg_owner_deletion_receipts WHERE schema_version < ${WORKGRAPH_SQLITE_SCHEMA_VERSION} LIMIT 1`).get()) {
    throw new Error("WorkGraph SQLite owner-deletion receipts use an owner-only subject hash; a trusted organization mapping is required before migration")
  }
}

function hasColumn(db: ReturnType<typeof sqlite>, table: string, column: string) {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((candidate) => candidate.name === column)
}

function invalidateLegacyAdmissionFallbacks(db: ReturnType<typeof sqlite>) {
  const now = Date.now()
  const rows = db.query(`
    SELECT organization_id, owner_user_id, id, source_revision_id, proposed_work_json, created_at
    FROM wg_v2_admission_proposals WHERE lifecycle = 'proposed'
  `).all() as Array<{
    organization_id: string
    owner_user_id: string
    id: string
    source_revision_id: string | null
    proposed_work_json: string
    created_at: string | number
  }>
  rows.forEach((row) => {
    const value = parseObject(row.proposed_work_json)
    if (completeAgentAdmission(value)) return
    const source = parseObject(value.source)
    const retryable = typeof source.workSourceId === "string" && typeof source.revisionId === "string" && typeof source.contentHash === "string"
    const invalidated = {
      ...(retryable ? { source } : {}),
      planningEvidence: {
        ...(typeof value.targetStreamId === "string" ? { targetStreamId: value.targetStreamId } : {}),
        placementMatches: Array.isArray(value.placementMatches) ? value.placementMatches : [],
        duplicateMatches: Array.isArray(value.duplicateMatches) ? value.duplicateMatches : [],
      },
      generation: {
        method: "planning_failed",
        attempt: 0,
        reason: "Retired deterministic or incomplete admission plan is non-authoritative",
        invalidatedAt: now,
        retryable,
      },
    }
    db.run(`
      UPDATE wg_v2_admission_proposals SET lifecycle = 'planning_failed', proposed_work_json = ?,
        row_version = row_version + 1, updated_at = ? WHERE organization_id = ? AND owner_user_id = ? AND id = ? AND lifecycle = 'proposed'
    `, [JSON.stringify(invalidated), now, row.organization_id, row.owner_user_id, row.id])
    if (!retryable) return
    db.run(`
      INSERT INTO wg_v2_due_jobs
        (organization_id, owner_user_id, id, job_type, subject_id, due_at, status, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, 'source_plan', ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(organization_id, owner_user_id, job_type, subject_id) DO UPDATE SET
        due_at = excluded.due_at, status = 'pending', payload_json = excluded.payload_json,
        claimed_by = NULL, claim_expires_at = NULL, last_error = NULL,
        row_version = wg_v2_due_jobs.row_version + 1, updated_at = excluded.updated_at
    `, [
      row.organization_id,
      row.owner_user_id,
      `source_plan_job_${row.id}`,
      row.id,
      now,
      JSON.stringify({ proposalId: row.id, source, automaticFailureCount: 0 }),
      Number(row.created_at),
      now,
    ])
  })
}

function repairLegacySourcePlanPublications(db: ReturnType<typeof sqlite>) {
  const rows = db.query(`
    SELECT operations.organization_id, operations.owner_user_id, operations.id, operations.change_cursor, events.payload_json
    FROM wg_v2_operation_results operations
    JOIN wg_v2_events events
      ON events.organization_id = operations.organization_id AND events.owner_user_id = operations.owner_user_id
      AND events.operation_id = operations.id
    JOIN wg_v2_changes changes
      ON changes.organization_id = operations.organization_id AND changes.owner_user_id = operations.owner_user_id
      AND changes.operation_id = operations.id AND changes.cursor = operations.change_cursor
    WHERE operations.command_type = 'source_plan_publication'
      AND operations.request_hash = operations.id AND operations.result_json = '{}'
      AND operations.change_cursor IS NOT NULL
      AND (SELECT COUNT(*) FROM wg_v2_events matching_events
        WHERE matching_events.organization_id = operations.organization_id
          AND matching_events.owner_user_id = operations.owner_user_id
          AND matching_events.operation_id = operations.id) = 1
      AND (SELECT COUNT(*) FROM wg_v2_changes matching_changes
        WHERE matching_changes.organization_id = operations.organization_id
          AND matching_changes.owner_user_id = operations.owner_user_id
          AND matching_changes.operation_id = operations.id) = 1
  `).all() as Array<{
    organization_id: string
    owner_user_id: string
    id: string
    change_cursor: number
    payload_json: string
  }>
  rows.forEach((row) => {
    const value = parseObject(row.payload_json)
    if (typeof value.proposalId !== "string" || typeof value.workSourceId !== "string" ||
      typeof value.version !== "number" || !value.generation || typeof value.generation !== "object") return
    db.run(`
      UPDATE wg_v2_operation_results SET request_hash = ?, result_json = ?
      WHERE organization_id = ? AND owner_user_id = ? AND id = ?
        AND command_type = 'source_plan_publication' AND request_hash = id AND result_json = '{}'
    `, [
      createHash("sha256").update(row.id).digest("hex"),
      JSON.stringify({
        ok: true,
        operationId: row.id,
        cursor: createChangeCursor({
          organizationId: row.organization_id,
          ownerUserId: row.owner_user_id,
          position: row.change_cursor,
        }),
        value,
      }),
      row.organization_id,
      row.owner_user_id,
      row.id,
    ])
  })
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return parseObject(JSON.parse(value))
    } catch {
      return {}
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function completeAgentAdmission(value: Record<string, unknown>) {
  const generation = parseObject(value.generation)
  if (generation.method !== "agent_session" || typeof generation.sessionId !== "string" ||
    typeof generation.generatedAt !== "number" || !Array.isArray(value.outcomes) || !Array.isArray(value.workItems)) return false
  return AdmissionAgentPlanSchema.safeParse({
    source: value.source,
    suggestedPlacement: value.suggestedPlacement,
    placementMatches: value.placementMatches,
    proposedOutcomes: value.outcomes.map((outcome) => {
      const row = parseObject(outcome)
      return {
        key: row.proposalKey,
        title: row.title,
        ...(typeof row.description === "string" ? { description: row.description } : {}),
        successCriteria: row.successCriteria,
        execution: row.execution,
      }
    }),
    proposedWorkItems: value.workItems.map((item) => {
      const row = parseObject(item)
      return {
        key: row.proposalKey,
        ...(typeof row.outcomeProposalKey === "string" ? { outcomeKey: row.outcomeProposalKey } : {}),
        title: row.title,
        ...(typeof row.description === "string" ? { description: row.description } : {}),
        dependencyKeys: row.dependencyProposalKeys,
        completionContract: row.completionContract,
        execution: row.execution,
      }
    }),
    duplicateMatches: value.duplicateMatches,
  }).success
}
