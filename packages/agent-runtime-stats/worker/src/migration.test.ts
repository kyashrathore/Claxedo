import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { expect, test } from "bun:test"

function migration(name: string): string {
  return readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")
}

test("migrates legacy reports without inventing the new placement metrics", () => {
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
  database.exec(migration("0004_add_turn_placement_metrics.sql"))

  expect(database.query("SELECT * FROM reports").get()).toMatchObject({
    schema_version: 2,
    sessions_without_full_machine_percent: null,
    turns_analyzed: 0,
    turn_coverage_percent: null,
    og_png: null,
    og_generated_at: null,
    og_retry_after: null,
  })
  const columns = database.query("PRAGMA table_info(reports)").all() as Array<{ name: string }>
  expect(columns.map((column) => column.name)).not.toContain("workerd_percent")
  expect(columns.map((column) => column.name)).not.toContain("just_bash_percent")
  expect(columns.map((column) => column.name)).toContain("repeat_full_machine_turn_percent")
  expect(() =>
    database
      .query(
        `INSERT INTO reports (
          id, schema_version, sessions_analyzed, execution_calls,
          sessions_without_full_machine_percent, turns_analyzed,
          turn_coverage_percent, turns_without_full_machine_percent,
          repeat_full_machine_turn_percent, median_calls_after_first_full_machine,
          median_observed_span_after_first_full_machine_ms,
          p95_observed_span_after_first_full_machine_ms
        ) VALUES (?, 2, 1, 10, 50, 2, 100, 50, 100, 1, 1000, 1000)`,
      )
      .run("b".repeat(32)),
  ).not.toThrow()
})
