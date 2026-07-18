import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, expect, test } from "vitest"
import { initializeWorkGraphSqliteSchema } from "../src/adapters/sqlite/schema"

const databases: BetterSqlite3.Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function database() {
  const result = new BetterSqlite3(":memory:")
  databases.push(result)
  return result
}

function tables(db: BetterSqlite3.Database) {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wg_v2_%' ORDER BY name").all() as Array<{ name: string }>).map(
    (row) => row.name,
  )
}

function columns(db: BetterSqlite3.Database, table: string) {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>
}

function indexes(db: BetterSqlite3.Database, table: string) {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((row) => ({
    name: row.name,
    columns: (db.prepare(`PRAGMA index_info(${row.name})`).all() as Array<{ name: string }>).map((column) => column.name),
  }))
}

describe("WorkGraph SQLite v2 schema", () => {
  test("creates every first-class durable record table", () => {
    const db = database()
    initializeWorkGraphSqliteSchema(db)

    expect(tables(db)).toEqual([
      "wg_v2_admission_proposals",
      "wg_v2_agent_checkpoints",
      "wg_v2_archive_restores",
      "wg_v2_attempts",
      "wg_v2_attention_acknowledgements",
      "wg_v2_change_cursors",
      "wg_v2_changes",
      "wg_v2_decision_work_items",
      "wg_v2_decisions",
      "wg_v2_due_jobs",
      "wg_v2_durable_effect_receipts",
      "wg_v2_events",
      "wg_v2_evidence",
      "wg_v2_external_identities",
      "wg_v2_intake_candidates",
      "wg_v2_leases",
      "wg_v2_migration_intake",
      "wg_v2_operation_results",
      "wg_v2_outbox",
      "wg_v2_outcomes",
      "wg_v2_record_source_revisions",
      "wg_v2_runtime_effects",
      "wg_v2_session_bindings",
      "wg_v2_source_views",
      "wg_v2_stream_cleanup_reservations",
      "wg_v2_stream_sequences",
      "wg_v2_streams",
      "wg_v2_webhook_deliveries",
      "wg_v2_work_item_dependencies",
      "wg_v2_work_items",
      "wg_v2_work_source_revisions",
      "wg_v2_work_sources",
      "wg_v2_workgraphs",
    ])
  })

  test("makes every owner-scoped key and lookup owner-first", () => {
    const db = database()
    initializeWorkGraphSqliteSchema(db)

    for (const table of tables(db)) {
      if (table === "wg_v2_webhook_deliveries") continue
      const primaryKey = columns(db, table)
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name)
      expect(primaryKey.slice(0, 2), `${table} primary key`).toEqual(["organization_id", "owner_user_id"])
      expect(columns(db, table).map((column) => column.name), `${table} schema version`).toContain("schema_version")

      const lookupIndexes = indexes(db, table).filter((index) => !index.name.startsWith("sqlite_autoindex"))
      for (const index of lookupIndexes) expect(index.columns.slice(0, 2), `${index.name} on ${table}`).toEqual(["organization_id", "owner_user_id"])
    }
  })

  test("drops the retired execution-mode recovery index and columns and pauses non-running Streams on upgrade", () => {
    const db = database()
    initializeWorkGraphSqliteSchema(db)
    // Simulate a pre-approval-gate database: re-add the retired mode columns/index and seed streams.
    db.exec(`
      ALTER TABLE wg_v2_streams ADD COLUMN execution_mode TEXT;
      ALTER TABLE wg_v2_streams ADD COLUMN execution_state TEXT;
      ALTER TABLE wg_v2_attempts ADD COLUMN execution_mode TEXT;
      CREATE INDEX wg_v2_streams_execution_idx ON wg_v2_streams(organization_id, owner_user_id, execution_state, updated_at);
      INSERT INTO wg_v2_workgraphs (organization_id, owner_user_id, id, created_at, updated_at) VALUES ('o','u','wg','1','1');
      INSERT INTO wg_v2_streams (organization_id, owner_user_id, id, workgraph_id, title, purpose, lifecycle, execution_mode, execution_state, created_at, updated_at)
      VALUES ('o','u','s_active','wg','T','P','active','autonomous','active','1','1'),
             ('o','u','s_stopped','wg','T','P','active','autonomous','stopped','1','1'),
             ('o','u','s_never','wg','T','P','active',NULL,NULL,'1','1'),
             ('o','u','s_paused','wg','T','P','paused',NULL,NULL,'1','1');
    `)

    initializeWorkGraphSqliteSchema(db)

    const streamColumns = columns(db, "wg_v2_streams").map((column) => column.name)
    expect(streamColumns).not.toContain("execution_mode")
    expect(streamColumns).not.toContain("execution_state")
    expect(columns(db, "wg_v2_attempts").map((column) => column.name)).not.toContain("execution_mode")
    expect(indexes(db, "wg_v2_streams").find((index) => index.name === "wg_v2_streams_execution_idx")).toBeUndefined()
    // Only the previously-active autonomous Stream keeps running; stopped, never-executed
    // (NULL), and already-paused Streams end paused so nothing auto-launches on upgrade.
    expect(db.prepare("SELECT id, lifecycle FROM wg_v2_streams ORDER BY id").all()).toEqual([
      { id: "s_active", lifecycle: "active" },
      { id: "s_never", lifecycle: "paused" },
      { id: "s_paused", lifecycle: "paused" },
      { id: "s_stopped", lifecycle: "paused" },
    ])
  })

  test("enforces owner-bound relationships and monotonic ordering constraints", () => {
    const db = database()
    initializeWorkGraphSqliteSchema(db)
    db.exec(`
      INSERT INTO wg_v2_workgraphs (organization_id, owner_user_id, id, created_at, updated_at)
      VALUES ('organization_a', 'user_a', 'graph_a', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z');
      INSERT INTO wg_v2_streams (organization_id, owner_user_id, id, workgraph_id, title, purpose, lifecycle, created_at, updated_at)
      VALUES ('organization_a', 'user_a', 'stream_a', 'graph_a', 'Ship', 'Ship product', 'active', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z');
      INSERT INTO wg_v2_operation_results (organization_id, owner_user_id, id, command_type, request_hash, result_status, result_json, created_at)
      VALUES ('organization_a', 'user_a', 'op_1', 'create_stream', 'hash_1', 200, '{}', '2026-07-13T00:00:00.000Z');
      INSERT INTO wg_v2_work_items (organization_id, owner_user_id, id, stream_id, outcome_id, title, lifecycle, created_at, updated_at)
      VALUES ('organization_a', 'user_a', 'item_1', 'stream_a', NULL, 'Stream-level item', 'ready', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z');
      INSERT INTO wg_v2_work_sources (organization_id, owner_user_id, id, workgraph_id, title, latest_revision_number, created_at, updated_at)
      VALUES ('organization_a', 'user_a', 'source_1', 'graph_a', 'Plan', 2, '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z');
      INSERT INTO wg_v2_work_source_revisions (organization_id, owner_user_id, id, work_source_id, revision_number, content, content_hash, created_at)
      VALUES
        ('organization_a', 'user_a', 'revision_1', 'source_1', 1, 'First', 'hash_revision_1', '2026-07-13T00:00:00.000Z'),
        ('organization_a', 'user_a', 'revision_2', 'source_1', 2, 'Second', 'hash_revision_2', '2026-07-13T00:00:01.000Z');
      INSERT INTO wg_v2_record_source_revisions (organization_id, owner_user_id, id, record_type, record_id, work_source_id, source_revision_id, ordinal, created_at)
      VALUES
        ('organization_a', 'user_a', 'source_ref_1', 'stream', 'stream_a', 'source_1', 'revision_1', 0, '2026-07-13T00:00:00.000Z'),
        ('organization_a', 'user_a', 'source_ref_2', 'stream', 'stream_a', 'source_1', 'revision_2', 1, '2026-07-13T00:00:01.000Z');
      INSERT INTO wg_v2_attempts (organization_id, owner_user_id, id, stream_id, work_item_id, attempt_number, lifecycle, resolved_execution_profile_json, created_at, updated_at)
      VALUES ('organization_a', 'user_a', 'attempt_1', 'stream_a', 'item_1', 1, 'admitted', '{}', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z');
      INSERT INTO wg_v2_evidence (organization_id, owner_user_id, id, stream_id, subject_type, subject_id, requirement_id, source_attempt_id, evidence_kind, summary, provenance_json, created_at)
      VALUES ('organization_a', 'user_a', 'evidence_1', 'stream_a', 'work_item', 'item_1', 'requirement_1', 'attempt_1', 'test', 'Focused proof', '{}', '2026-07-13T00:00:00.000Z');
      INSERT INTO wg_v2_events (organization_id, owner_user_id, id, stream_id, sequence, schema_version, operation_id, event_type, actor_type, actor_id, request_id, payload_json, occurred_at)
      VALUES ('organization_a', 'user_a', 'event_1', 'stream_a', 1, 1, 'op_1', 'stream.created', 'user', 'user_a', 'request_1', '{}', '2026-07-13T00:00:00.000Z');
      INSERT INTO wg_v2_operation_results (organization_id, owner_user_id, id, command_type, request_hash, result_status, result_json, created_at)
      VALUES ('organization_a', 'user_a', 'op_2', 'update_stream', 'hash_2', 200, '{}', '2026-07-13T00:00:01.000Z');
    `)
    expect(db.prepare("SELECT outcome_id FROM wg_v2_work_items WHERE owner_user_id = ? AND id = ?").get("user_a", "item_1")).toEqual({ outcome_id: null })
    expect(
      db.prepare("SELECT source_revision_id FROM wg_v2_record_source_revisions WHERE owner_user_id = ? AND record_type = ? AND record_id = ? ORDER BY ordinal").all(
        "user_a",
        "stream",
        "stream_a",
      ),
    ).toEqual([{ source_revision_id: "revision_1" }, { source_revision_id: "revision_2" }])
    expect(db.prepare("SELECT requirement_id, source_attempt_id FROM wg_v2_evidence WHERE owner_user_id = ? AND id = ?").get("user_a", "evidence_1")).toEqual({
      requirement_id: "requirement_1",
      source_attempt_id: "attempt_1",
    })
    expect(db.pragma("foreign_key_check")).toEqual([])

    expect(() =>
      db.exec(`
        INSERT INTO wg_v2_events (organization_id, owner_user_id, id, stream_id, sequence, schema_version, operation_id, event_type, actor_type, actor_id, request_id, payload_json, occurred_at)
        VALUES ('organization_a', 'user_a', 'event_2', 'stream_a', 1, 1, 'op_2', 'stream.updated', 'user', 'user_a', 'request_2', '{}', '2026-07-13T00:00:01.000Z')
      `),
    ).toThrow()
    expect(() =>
      db.exec(`
        INSERT INTO wg_v2_stream_sequences (organization_id, owner_user_id, stream_id, next_sequence, created_at, updated_at)
        VALUES ('organization_a', 'user_a', 'stream_a', 0, '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z')
      `),
    ).toThrow()
    expect(() =>
      db.exec(`
        INSERT INTO wg_v2_change_cursors (organization_id, owner_user_id, next_cursor, created_at, updated_at)
        VALUES ('organization_a', 'user_a', 0, '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z')
      `),
    ).toThrow()
    expect(() =>
      db.exec(`
        INSERT INTO wg_v2_outcomes (organization_id, owner_user_id, id, stream_id, title, lifecycle, success_criteria_json, created_at, updated_at)
        VALUES ('organization_b', 'user_b', 'outcome_b', 'stream_a', 'Cross-owner', 'active', '[]', '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z')
      `),
    ).toThrow()
  })

  test("contains no credential material and preserves unrelated legacy tables on safe rerun", () => {
    const db = database()
    db.exec("CREATE TABLE legacy_runs (id TEXT PRIMARY KEY, token TEXT NOT NULL)")
    db.exec("INSERT INTO legacy_runs (id, token) VALUES ('legacy_1', 'preserve-me')")

    initializeWorkGraphSqliteSchema(db)
    expect(() => initializeWorkGraphSqliteSchema(db)).not.toThrow()

    const forbidden = /(^|_)(token|secret|credential|password|api_key|access_key)($|_)/
    for (const table of tables(db)) {
      expect(columns(db, table).map((column) => column.name).filter((column) => forbidden.test(column)), table).toEqual([])
    }
    expect(db.prepare("SELECT * FROM legacy_runs").get()).toEqual({ id: "legacy_1", token: "preserve-me" })
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1)
  })

  test("keeps logical Stream event and change history independent from aggregate deletion", () => {
    const db = database()
    initializeWorkGraphSqliteSchema(db)

    const eventStream = db.prepare("PRAGMA table_info(wg_v2_events)").all()
      .find((column) => (column as { name: string }).name === "stream_id") as { notnull: number }
    expect(eventStream.notnull).toBe(0)
    for (const table of ["wg_v2_events", "wg_v2_changes", "wg_v2_stream_sequences"]) {
      const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>
      expect(foreignKeys.map((key) => key.table), table).not.toContain("wg_v2_streams")
    }
  })

  test("persists Stream visibility and Outcome close/reopen provenance", () => {
    const db = database()
    initializeWorkGraphSqliteSchema(db)

    expect(columns(db, "wg_v2_streams").map((column) => column.name)).toContain("visibility")
    expect(columns(db, "wg_v2_outcomes").map((column) => column.name)).toEqual(expect.arrayContaining([
      "closed_by_json",
      "close_reason",
      "reopened_at",
      "reopen_reason",
    ]))
    expect(columns(db, "wg_v2_work_items").map((column) => column.name)).toContain("abandoned_at")
    db.exec(`
      INSERT INTO wg_v2_workgraphs (organization_id, owner_user_id, id, created_at, updated_at)
      VALUES ('organization', 'owner', 'workgraph_default', 1, 1);
      INSERT INTO wg_v2_streams (organization_id, owner_user_id, id, workgraph_id, title, purpose, lifecycle, created_at, updated_at)
      VALUES ('organization', 'owner', 'stream_1', 'workgraph_default', 'Ship', 'Ship', 'active', 1, 1);
    `)
    expect(db.prepare("SELECT visibility FROM wg_v2_streams WHERE owner_user_id = 'owner'").get()).toEqual({ visibility: "visible" })
  })
})
