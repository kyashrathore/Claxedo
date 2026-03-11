import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "fs"
import path from "path"
import { repair } from "./claxedo-repair"

function entries() {
  const dir = path.join(import.meta.dirname, "claxedo-migration")
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name, idx) => ({
      name,
      sql: readFileSync(path.join(dir, name, "migration.sql"), "utf-8"),
      timestamp: idx,
    }))
}

function hasTable(db: Database, name: string) {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

function hasColumn(db: Database, table: string, name: string) {
  const rows = db.query(`PRAGMA table_info(\`${table}\`)`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === name)
}

function apply(db: Database) {
  entries().forEach((entry) => {
    entry.sql
      .split("--> statement-breakpoint")
      .map((sql) => sql.trim())
      .filter(Boolean)
      .forEach((sql) => db.run(sql))
  })
}

describe("claxedo schema", () => {
  test("bundled migrations create the full schema", () => {
    const sqlite = new Database(":memory:")

    apply(sqlite)

    expect(hasTable(sqlite, "claxedo_page")).toBe(true)
    expect(hasTable(sqlite, "claxedo_page_status")).toBe(true)
    expect(hasTable(sqlite, "claxedo_page_arena")).toBe(true)
    expect(hasTable(sqlite, "claxedo_tab_context")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_page", "file_path")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_page", "directory")).toBe(true)
  })

  test("repair heals partial migrations", () => {
    const sqlite = new Database(":memory:")

    sqlite.run(
      "CREATE TABLE `claxedo_page` (`id` text PRIMARY KEY NOT NULL, `project_id` text NOT NULL, `title` text NOT NULL DEFAULT 'Untitled', `content` text NOT NULL DEFAULT '', `status` text NOT NULL DEFAULT 'draft', `session_id` text, `created_at` text NOT NULL, `updated_at` text NOT NULL, `file_path` text)",
    )

    const fixed = repair(sqlite)

    expect(fixed).toContain("claxedo_page_status")
    expect(fixed).toContain("claxedo_page.directory")
    expect(hasTable(sqlite, "claxedo_page_status")).toBe(true)
    expect(hasTable(sqlite, "claxedo_page_arena")).toBe(true)
    expect(hasColumn(sqlite, "claxedo_page", "directory")).toBe(true)
  })
})
