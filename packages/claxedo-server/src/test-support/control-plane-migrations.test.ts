import Database from "better-sqlite3"
import type { D1Database } from "@cloudflare/workers-types"
import { afterEach, expect, test } from "vitest"
import { applyControlPlaneMigration, controlPlaneMigrations } from "./control-plane-migrations"

const active: Database.Database[] = []
afterEach(() => { active.splice(0).forEach((database) => database.close()) })

function fixture() {
  const sqlite = new Database(":memory:")
  sqlite.pragma("foreign_keys = ON")
  active.push(sqlite)
  const d1 = {
    prepare(sql: string) {
      return {
        async all() { return { results: sqlite.prepare(sql).all() } },
        async run() { sqlite.exec(sql); return { success: true } },
      }
    },
    async batch(statements: { run(): Promise<unknown> }[]) {
      sqlite.exec("BEGIN")
      try {
        const results = []
        for (const statement of statements) results.push(await statement.run())
        sqlite.exec("COMMIT")
        return results
      } catch (error) {
        sqlite.exec("ROLLBACK")
        throw error
      }
    },
  } as unknown as D1Database
  return { sqlite, d1 }
}

test("conformance helpers expose only the canonical baseline", () => {
  expect(controlPlaneMigrations()).toEqual(["0001_baseline.sql"])
})

test("test migration application refuses old history without changing stored rows", async () => {
  const { sqlite, d1 } = fixture()
  sqlite.exec("create table d1_migrations (id integer primary key, name text); insert into d1_migrations(name) values ('0045_org_scope_means_org.sql'); create table old_rows(value text); insert into old_rows values ('keep');")
  await expect(applyControlPlaneMigration(d1, "0001_baseline.sql")).rejects.toThrow(/bun run d1:reset:staging/)
  expect(sqlite.prepare("select * from old_rows").all()).toEqual([{ value: "keep" }])
})

test("empty test databases apply and record the baseline once, and a repeated apply preserves rows", async () => {
  const { sqlite, d1 } = fixture()
  await applyControlPlaneMigration(d1, "0001_baseline.sql")
  expect(sqlite.prepare("select name from d1_migrations").all()).toEqual([{ name: "0001_baseline.sql" }])
  sqlite.exec("insert into users(user_id, state, created_at, updated_at) values ('keep', 'active', 1, 1)")
  await applyControlPlaneMigration(d1, "0001_baseline.sql")
  expect(sqlite.prepare("select user_id from users").all()).toEqual([{ user_id: "keep" }])
})

test("test migration application refuses untracked nonempty schemas", async () => {
  const { sqlite, d1 } = fixture()
  sqlite.exec("create table old_rows(value text)")
  await expect(applyControlPlaneMigration(d1, "0001_baseline.sql")).rejects.toThrow(/untracked.*schema/)
})
