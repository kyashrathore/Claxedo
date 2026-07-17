import Database from "better-sqlite3"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { getTableConfig } from "drizzle-orm/sqlite-core"
import { describe, expect, test } from "vitest"
import { ClaxedoDB } from "./db"
import { ClaxedoDocumentIndexTable } from "./document-index.sql"
import { repair } from "./repair"

const resetMigration = "20260716000100_documents_reset"
const retiredPageTable = ["claxedo", "page"].join("_")
const retiredArenaTable = ["claxedo", "page", "arena"].join("_")

function migrations() {
  return readdirSync(path.join(import.meta.dirname, "claxedo-migration"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(path.join(import.meta.dirname, "claxedo-migration", name, "migration.sql"), "utf8"),
    }))
}

function apply(db: InstanceType<typeof Database>, sql: string) {
  sql.split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean)
    .forEach((statement) => db.exec(statement))
}

function columns(db: InstanceType<typeof Database>, table: string) {
  return (db.prepare(`PRAGMA table_info(\`${table}\`)`).all() as Array<{ name: string }>).map((row) => row.name)
}

const insertIndex = `
  INSERT INTO claxedo_document_index (
    id, org_id, project_id, display_name, origin_kind, placement_kind, placement_id,
    managed_relative_path, repository_id, workspace_id, repository_relative_path, branch,
    status, session_id, archived_at, created_at, updated_at, last_opened_at, last_known_file_version
  ) VALUES (
    @id, @org_id, @project_id, @display_name, @origin_kind, @placement_kind, @placement_id,
    @managed_relative_path, @repository_id, @workspace_id, @repository_relative_path, @branch,
    @status, @session_id, @archived_at, @created_at, @updated_at, @last_opened_at, @last_known_file_version
  )
`

const managedIndexRow = {
  id: "document_1",
  org_id: "__local__",
  project_id: "project_1",
  display_name: "Document",
  origin_kind: "managed",
  placement_kind: "local",
  placement_id: "device_1",
  managed_relative_path: "document_1/document.md",
  repository_id: null,
  workspace_id: null,
  repository_relative_path: null,
  branch: null,
  status: "draft",
  session_id: null,
  archived_at: null,
  created_at: "2026-07-16T00:00:00.000Z",
  updated_at: "2026-07-16T00:00:00.000Z",
  last_opened_at: null,
  last_known_file_version: null,
}

function expectEmptyIndexValuesRejected(sqlite: InstanceType<typeof Database>) {
  const insert = sqlite.prepare(insertIndex)
  const managedFields = [
    "id",
    "org_id",
    "project_id",
    "display_name",
    "origin_kind",
    "placement_kind",
    "placement_id",
    "managed_relative_path",
    "status",
    "created_at",
    "updated_at",
    "session_id",
    "archived_at",
    "last_opened_at",
    "last_known_file_version",
  ]
  managedFields.forEach((field) => {
    expect(() => insert.run({ ...managedIndexRow, [field]: "" }), field).toThrow()
  })
  expect(() => insert.run({ ...managedIndexRow, managed_relative_path: null }), "managed_relative_path null").toThrow()

  const repository = {
    ...managedIndexRow,
    origin_kind: "repository",
    managed_relative_path: null,
    repository_id: "repository_1",
    workspace_id: "workspace_1",
    repository_relative_path: "docs/document.md",
    branch: "main",
  }
  ;["repository_id", "workspace_id", "repository_relative_path", "branch"].forEach((field) => {
    expect(() => insert.run({ ...repository, [field]: "" }), field).toThrow()
  })
  ;["repository_id", "workspace_id", "repository_relative_path"].forEach((field) => {
    expect(() => insert.run({ ...repository, [field]: null }), `${field} null`).toThrow()
  })

  expect(sqlite.prepare("SELECT COUNT(*) AS count FROM claxedo_document_index").get()).toEqual({ count: 0 })
}

describe("documents reset migration", () => {
  test("fresh databases install a content-free document index and retain statuses", () => {
    const sqlite = new Database(":memory:")

    migrations().forEach((migration) => apply(sqlite, migration.sql))

    const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name)
    expect(tables).toContain("claxedo_document_index")
    expect(tables).toContain("claxedo_local_project")
    expect(tables).toContain("claxedo_page_status")
    expect(tables).not.toContain(retiredPageTable)
    expect(tables).not.toContain("claxedo_document")
    expect(tables).not.toContain(["claxedo", "document", "revision"].join("_"))
    expect(tables.some((table) => table.startsWith(retiredArenaTable))).toBe(false)
    expect(columns(sqlite, "claxedo_document_index")).not.toContain("content")
    expect(migrations().some((migration) => migration.name === resetMigration)).toBe(true)
  })

  test("opening the managed database does not repair the legacy content table back into existence", () => {
    const previousDataDir = process.env.CLAXEDO_DATA_DIR
    const root = path.join(os.tmpdir(), `document-index-repair-${randomUUID()}`)
    mkdirSync(root, { recursive: true })
    ClaxedoDB.close()
    process.env.CLAXEDO_DATA_DIR = root

    const tables = (ClaxedoDB.raw().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name)

    expect(tables).toContain("claxedo_document_index")
    expect(tables).not.toContain(retiredPageTable)
    expect(tables).not.toContain("claxedo_document")
    expect(tables).not.toContain(["claxedo", "document", "revision"].join("_"))
    expect(tables.some((table) => table.startsWith(retiredArenaTable))).toBe(false)
    ClaxedoDB.close()
    rmSync(root, { recursive: true, force: true })
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDataDir
  })

  test("existing development databases are reset instead of migrating page content", () => {
    const sqlite = new Database(":memory:")
    sqlite.pragma("foreign_keys = ON")
    const entries = migrations()
    entries.filter((migration) => migration.name !== resetMigration).forEach((migration) => apply(sqlite, migration.sql))
    sqlite.prepare(`
      INSERT INTO ${retiredPageTable} (id, org_id, project_id, title, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("page_legacy", "__local__", "project_1", "Legacy", "secret body", "1", "1")
    sqlite.prepare(`
      INSERT INTO ${retiredArenaTable} (id, page_id, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run("arena_legacy", "page_legacy", 1, 1)
    sqlite.prepare(`
      INSERT INTO claxedo_page_status (id, project_id, name, color, position, transitions)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("custom", "project_1", "Custom", "#000000", 0, "[]")

    apply(sqlite, entries.find((migration) => migration.name === resetMigration)!.sql)

    const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name)
    expect(tables).not.toContain(retiredPageTable)
    expect(tables).not.toContain("claxedo_document")
    expect(tables).not.toContain(["claxedo", "document", "revision"].join("_"))
    expect(tables.some((table) => table.startsWith(retiredArenaTable))).toBe(false)
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM claxedo_document_index").get()).toEqual({ count: 0 })
    expect(sqlite.prepare("SELECT name FROM claxedo_page_status WHERE project_id = ? AND id = ?").get("project_1", "custom"))
      .toEqual({ name: "Custom" })
  })

  test("the real migration journal resets an existing database file", () => {
    const previousDataDir = process.env.CLAXEDO_DATA_DIR
    const root = path.join(os.tmpdir(), `document-index-journal-${randomUUID()}`)
    mkdirSync(root, { recursive: true })
    const sqlite = new Database(path.join(root, "claxedo.db"))
    sqlite.exec("CREATE TABLE __claxedo_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)")
    migrations().filter((migration) => migration.name !== resetMigration).forEach((migration) => {
      apply(sqlite, migration.sql)
      sqlite.prepare("INSERT INTO __claxedo_migrations (name, applied_at) VALUES (?, ?)").run(migration.name, 1)
    })
    sqlite.prepare(`
      INSERT INTO ${retiredPageTable} (id, org_id, project_id, title, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("page_legacy", "__local__", "project_1", "Legacy", "secret body", "1", "1")
    sqlite.close()

    ClaxedoDB.close()
    process.env.CLAXEDO_DATA_DIR = root
    const managed = ClaxedoDB.raw()
    const tables = (managed.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name)

    expect(tables).toContain("claxedo_document_index")
    expect(tables).not.toContain(retiredPageTable)
    expect(managed.prepare("SELECT name FROM __claxedo_migrations WHERE name = ?").get(resetMigration)).toEqual({
      name: resetMigration,
    })
    ClaxedoDB.close()
    rmSync(root, { recursive: true, force: true })
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDataDir
  })

  test("the SQL schema rejects mixed origin locators", () => {
    const sqlite = new Database(":memory:")
    migrations().forEach((migration) => apply(sqlite, migration.sql))

    expect(() => sqlite.prepare(`
      INSERT INTO claxedo_document_index (
        id, org_id, project_id, display_name, origin_kind, placement_kind, placement_id,
        managed_relative_path, repository_id, workspace_id, repository_relative_path,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "document_mixed",
      "__local__",
      "project_1",
      "Mixed",
      "managed",
      "local",
      "device_1",
      "document_mixed/mixed.md",
      "repository_1",
      "workspace_1",
      "docs/mixed.md",
      "draft",
      "2026-07-16T00:00:00.000Z",
      "2026-07-16T00:00:00.000Z",
    )).toThrow()
  })

  test("the SQL schema rejects every empty runtime-required value", () => {
    const sqlite = new Database(":memory:")
    migrations().forEach((migration) => apply(sqlite, migration.sql))

    expectEmptyIndexValuesRejected(sqlite)
  })

  test("the repair schema enforces the same empty-value constraints", () => {
    const sqlite = new Database(":memory:")
    repair(sqlite)

    expectEmptyIndexValuesRejected(sqlite)
  })

  test("the Drizzle schema declares every document index check", () => {
    expect(getTableConfig(ClaxedoDocumentIndexTable).checks.map((check) => check.name).sort()).toEqual([
      "claxedo_document_index_common_nonempty_check",
      "claxedo_document_index_optional_nonempty_check",
      "claxedo_document_index_origin_check",
      "claxedo_document_index_placement_check",
    ])
  })
})
