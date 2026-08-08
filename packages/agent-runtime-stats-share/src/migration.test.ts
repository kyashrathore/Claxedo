import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { expect, test } from "bun:test"

function migration(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")
}

test("folds the removed runtime tier into just-bash and invalidates stale social images", () => {
  const database = new Database(":memory:")
  database.exec(migration("0001_create_reports.sql"))
  database.exec(migration("0002_remove_ci_e2e_sessions_excluded.sql"))
  database
    .query(
      `INSERT INTO reports (
        id, schema_version, sessions_analyzed, execution_calls,
        just_bash_percent, workerd_percent, full_vm_percent,
        median_x_ms, p95_x_ms, og_png, og_generated_at
      ) VALUES (?, 1, 1, 100, 66, 4, 30, 11000, 113000, ?, ?)`,
    )
    .run("a".repeat(32), Uint8Array.from([1, 2, 3]), "2026-08-08T00:00:00.000Z")

  database.exec(migration("0003_remove_workerd_percent.sql"))

  expect(database.query("SELECT * FROM reports").get()).toMatchObject({
    just_bash_percent: 70,
    full_vm_percent: 30,
    og_png: null,
    og_generated_at: null,
  })
  const columns = database.query("PRAGMA table_info(reports)").all() as Array<{ name: string }>
  expect(columns.map((column) => column.name)).not.toContain("workerd_percent")
})
