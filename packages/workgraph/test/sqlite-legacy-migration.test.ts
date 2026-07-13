import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, expect, test } from "vitest"
import { initializeWorkGraphSqliteSchema } from "../src/adapters/sqlite/schema"
import { applyLegacyWorkGraphMigration, exportLegacyWorkGraphMigration } from "../src/adapters/sqlite/legacy-migration"
import { initializeDb } from "../src/db/schema"

const databases: BetterSqlite3.Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

function database() {
  const result = new BetterSqlite3(":memory:")
  databases.push(result)
  initializeDb(result)
  initializeWorkGraphSqliteSchema(result)
  return result
}

const target = {
  ownerUserId: "user_1",
  workgraphId: "workgraph_1",
  now: () => "2026-07-13T00:00:00.000Z",
  idFor: (kind: string, table: string, recordId: string) => `migration:${kind}:${table}:${recordId}`,
}

function seedLegacy(db: BetterSqlite3.Database) {
  db.prepare(
    "INSERT INTO sources_current (source_id, goal, kind, title, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("source_manual", "Ship safely", "manual", "Launch plan", "Do the launch work", "draft", "2026-07-01", "2026-07-02")
  db.prepare(
    "INSERT INTO sources_current (source_id, goal, kind, title, content, status, provider, provider_connection_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("source_external", "Fix issue", "github", "Issue 42", "External body", "ready", "github", "connection_1", "2026-07-01", "2026-07-02")
  db.prepare("INSERT INTO runs_current (run_id, goal, status, source_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "run_1",
    "Execute launch",
    "completed",
    "source_manual",
    "2026-07-02",
    "2026-07-03",
  )
  db.prepare("INSERT INTO nodes_current (node_id, run_id, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?)").run(
    "node_1",
    "run_1",
    "task",
    "Deploy",
    "completed",
    0,
  )
  db.prepare(
    "INSERT INTO attempts_current (attempt_id, run_id, node_id, status, runtime_type, started_at, last_heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("attempt_1", "run_1", "node_1", "completed", "task", "2026-07-02", "2026-07-03")
  db.prepare("INSERT INTO run_node_items_current (run_id, node_id, work_item_id) VALUES (?, ?, ?)").run("run_1", "node_1", "legacy_item_1")
  db.prepare("INSERT INTO provider_connections_current (connection_id, provider, name, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "connection_1",
    "github",
    "Team GitHub",
    "secret-token-that-must-never-migrate",
    "2026-07-01",
    "2026-07-01",
  )
}

describe("legacy WorkGraph migration", () => {
  test("exports a credential-free dry-run and makes no changes", () => {
    const db = database()
    seedLegacy(db)

    const report = exportLegacyWorkGraphMigration(db, target)

    expect(report.sources).toHaveLength(1)
    expect(report.sources[0]).toMatchObject({ legacyRecordId: "source_manual", title: "Launch plan", content: "Do the launch work" })
    expect(report.intake.map((row) => [row.legacyTable, row.legacyRecordId])).toEqual(
      expect.arrayContaining([
        ["sources_current", "source_external"],
        ["runs_current", "run_1"],
        ["nodes_current", "node_1"],
        ["attempts_current", "attempt_1"],
        ["run_node_items_current", "run_1:node_1:legacy_item_1"],
      ]),
    )
    expect(report.skippedCredentialRecords).toBe(1)
    expect(JSON.stringify(report)).not.toContain("secret-token-that-must-never-migrate")
    expect(db.prepare("SELECT COUNT(*) AS count FROM wg_v2_workgraphs").get()).toEqual({ count: 0 })
  })

  test("applies only provable manual sources and surfaces ambiguous work without fabricating completion", () => {
    const db = database()
    seedLegacy(db)

    const result = applyLegacyWorkGraphMigration(db, target)

    expect(result).toMatchObject({ applied: true, migratedSources: 1 })
    expect(db.prepare("SELECT id, title, source_kind FROM wg_v2_work_sources").all()).toEqual([
      { id: "migration:source:sources_current:source_manual", title: "Launch plan", source_kind: "manual" },
    ])
    expect(db.prepare("SELECT content, origin_kind FROM wg_v2_work_source_revisions").all()).toEqual([
      { content: "Do the launch work", origin_kind: "manual" },
    ])
    expect(db.prepare("SELECT COUNT(*) AS count FROM wg_v2_streams").get()).toEqual({ count: 0 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM wg_v2_work_items").get()).toEqual({ count: 0 })
    expect(db.prepare("SELECT legacy_table, legacy_record_id, reason FROM wg_v2_migration_intake ORDER BY legacy_table, legacy_record_id").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ legacy_table: "runs_current", legacy_record_id: "run_1", reason: expect.stringContaining("completion") }),
        expect.objectContaining({ legacy_table: "nodes_current", legacy_record_id: "node_1", reason: expect.stringContaining("Work Item") }),
        expect.objectContaining({ legacy_table: "attempts_current", legacy_record_id: "attempt_1", reason: expect.stringContaining("completion") }),
        expect.objectContaining({ legacy_table: "run_node_items_current", reason: expect.stringContaining("identities") }),
      ]),
    )
    expect(JSON.stringify(db.prepare("SELECT * FROM wg_v2_migration_intake").all())).not.toContain("secret-token-that-must-never-migrate")
  })

  test("is idempotent and preserves every legacy row", () => {
    const db = database()
    seedLegacy(db)
    const legacyCounts = Object.fromEntries(
      ["sources_current", "runs_current", "nodes_current", "attempts_current", "run_node_items_current", "provider_connections_current"].map((table) => [
        table,
        (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
      ]),
    )

    applyLegacyWorkGraphMigration(db, target)
    applyLegacyWorkGraphMigration(db, target)

    expect(db.prepare("SELECT COUNT(*) AS count FROM wg_v2_work_sources").get()).toEqual({ count: 1 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM wg_v2_work_source_revisions").get()).toEqual({ count: 1 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM wg_v2_migration_intake").get()).toEqual({ count: 5 })
    for (const [table, count] of Object.entries(legacyCounts)) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count })
    }
  })

  test.each([
    ["intake kind", "intake_kind = 'source_review'"],
    ["reason", "reason = 'stale reason'"],
    ["raw reference", "raw_reference_json = '{}'"],
  ])("rejects a rerun when an existing intake row has a stale %s", (_field, assignment) => {
    const db = database()
    seedLegacy(db)
    applyLegacyWorkGraphMigration(db, target)
    db.prepare(
      `UPDATE wg_v2_migration_intake
       SET ${assignment}
       WHERE owner_user_id = ? AND legacy_table = 'runs_current' AND legacy_record_id = 'run_1'`,
    ).run(target.ownerUserId)

    expect(() => applyLegacyWorkGraphMigration(db, target)).toThrow("Legacy migration ID collision for runs_current:run_1")
  })

  test("rolls back the whole apply when any v2 write fails", () => {
    const db = database()
    seedLegacy(db)
    db.exec(`
      CREATE TRIGGER reject_legacy_source
      BEFORE INSERT ON wg_v2_work_source_revisions
      BEGIN
        SELECT RAISE(ABORT, 'forced migration failure');
      END;
    `)

    expect(() => applyLegacyWorkGraphMigration(db, target)).toThrow("forced migration failure")
    expect(db.prepare("SELECT COUNT(*) AS count FROM wg_v2_workgraphs").get()).toEqual({ count: 0 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM wg_v2_work_sources").get()).toEqual({ count: 0 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM wg_v2_migration_intake").get()).toEqual({ count: 0 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM sources_current").get()).toEqual({ count: 2 })
  })
})
