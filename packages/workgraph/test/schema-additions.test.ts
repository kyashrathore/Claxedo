import BetterSqlite3 from "better-sqlite3"
import { afterEach, describe, expect, test } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openSqlite } from "../src/model/db"

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDbPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "workgraph-schema-"))
  dirs.push(dir)
  return path.join(dir, "graph.sqlite")
}

function bootDb(dbPath = tempDbPath()) {
  const repo = openSqlite(dbPath)
  repo.close()
  return dbPath
}

function inspect(dbPath: string) {
  const db = new BetterSqlite3(dbPath)
  return {
    columns(table: string) {
      return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)
    },
    indexPlan(sql: string) {
      return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>
    },
    exec(sql: string) {
      db.exec(sql)
    },
    close() {
      db.close()
    },
  }
}

describe("WorkGraph schema additions", () => {
  test("creates async intake tables and scratchpad evolution columns", () => {
    const db = inspect(bootDb())
    expect(db.columns("wg_intake_items")).toEqual([
      "id",
      "kind",
      "title",
      "body_md",
      "status",
      "repo_ref",
      "triage_mode_override",
      "linked_session_id",
      "created_at",
      "updated_at",
      "last_triaged_at",
    ])
    expect(db.columns("wg_intake_activities")).toEqual([
      "id",
      "intake_item_id",
      "kind",
      "actor",
      "payload_json",
      "created_at",
    ])
    expect(db.columns("wg_external_references")).toEqual([
      "id",
      "intake_item_id",
      "provider",
      "external_id",
      "external_url",
      "last_known_state_json",
      "created_at",
    ])
    expect(db.columns("wg_external_event_dedup")).toEqual([
      "provider",
      "external_id",
      "external_event_id",
      "received_at",
    ])
    expect(db.columns("wg_reviewable_decisions")).toEqual([
      "id",
      "kind",
      "intent_kind",
      "subject_type",
      "subject_id",
      "prompt_md",
      "recommended_intent_payload_json",
      "alternatives_json",
      "free_text_answer",
      "confidence",
      "evidence_md",
      "default_action",
      "auto_apply_allowed",
      "status",
      "batch_id",
      "created_by",
      "created_at",
      "resolved_at",
    ])
    expect(db.columns("wg_review_batches")).toEqual([
      "id",
      "submitted_by",
      "submitted_at",
      "created_at",
    ])
    expect(db.columns("wg_loadout_slots")).toEqual([
      "id",
      "scope_type",
      "scope_id",
      "kind",
      "payload_json",
      "created_at",
      "updated_at",
    ])
    expect(db.columns("wg_scratchpads")).toContain("agent_run_id")
    expect(db.columns("wg_scratchpads")).toContain("kind")
    expect(db.columns("wg_scratchpads")).toContain("subject_type")
    expect(db.columns("wg_scratchpads")).toContain("subject_id")
    db.close()
  })

  test("schema boot is idempotent", () => {
    const dbPath = bootDb()
    expect(() => bootDb(dbPath)).not.toThrow()
  })

  test("enforces external identity and webhook delivery deduplication", () => {
    const db = inspect(bootDb())
    db.exec(`
      INSERT INTO wg_intake_items (id, kind, body_md, status, created_at, updated_at)
      VALUES ('intake_1', 'external', 'Issue', 'captured', '2026-05-02T00:00:00.000Z', '2026-05-02T00:00:00.000Z');
      INSERT INTO wg_external_references (id, intake_item_id, provider, external_id, created_at)
      VALUES ('ref_1', 'intake_1', 'github', '42', '2026-05-02T00:00:00.000Z');
    `)
    expect(() =>
      db.exec(`
        INSERT INTO wg_external_references (id, intake_item_id, provider, external_id, created_at)
        VALUES ('ref_2', 'intake_1', 'github', '42', '2026-05-02T00:00:01.000Z')
      `),
    ).toThrow()
    db.exec(`
      INSERT INTO wg_external_event_dedup (provider, external_id, external_event_id, received_at)
      VALUES ('github', '42', 'delivery-1', '2026-05-02T00:00:00.000Z')
    `)
    expect(() =>
      db.exec(`
        INSERT INTO wg_external_event_dedup (provider, external_id, external_event_id, received_at)
        VALUES ('github', '42', 'delivery-1', '2026-05-02T00:00:01.000Z')
      `),
    ).toThrow()
    db.close()
  })

  test("indexes loadout scope lookups", () => {
    const db = inspect(bootDb())
    expect(db.indexPlan(`
      SELECT * FROM wg_loadout_slots
      WHERE scope_type = 'repo' AND scope_id = 'github:acme/app' AND kind = 'triage_mode'
    `).map((row) => row.detail).join("\n")).toContain("wg_loadout_slots_scope_kind_idx")
    db.close()
  })
})
