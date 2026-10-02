import { beforeEach, expect, test, vi } from "vitest"
import Database from "better-sqlite3"
import { currentControlPlaneBaseline } from "../control-plane-schema"
import { prepareD1Databases } from "./d1-databases"

const wrangler = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock("./wrangler-cli", () => ({ runWrangler: wrangler.run }))
const input = { configArgs: ["--config", "staging.toml"], apiOrigin: "https://api.test", betterAuthSecret: "a".repeat(32), introspectionSecret: "b".repeat(32) }
beforeEach(() => { wrangler.run.mockReset() })

const BASELINE = currentControlPlaneBaseline()

// The table `wrangler d1 migrations apply` creates (wrangler 4.114, getCreateMigrationsTableQuery).
function record(database: Database.Database, name: string) {
  database.exec(`CREATE TABLE IF NOT EXISTS "d1_migrations"(
\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,
\t\tname       TEXT UNIQUE,
\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`)
  database.prepare(`INSERT INTO "d1_migrations" (name) values (?)`).run(name)
}

async function deploy(database: Database.Database) {
  wrangler.run.mockImplementation(async (args: string[]) => {
    if (args[1] === "migrations") {
      if (args[3] === "CONTROL_PLANE_DB" && !database.prepare("select 1 from sqlite_master").all().length) {
        database.exec(BASELINE)
        record(database, "0001_baseline.sql")
      }
      return ""
    }
    if (args[2] !== "CONTROL_PLANE_DB") throw new Error("auth provisioning starts")
    return JSON.stringify([{ success: true, results: database.prepare(args[args.indexOf("--command") + 1]!).all() }])
  })
  return prepareD1Databases(input)
}

const applied = () => wrangler.run.mock.calls.filter(([args]) => args[1] === "migrations").map(([args]) => args[3])

test.each([
  ["older migration history", "0045_org_scope_means_org.sql", (database: Database.Database) => {
    database.exec(BASELINE)
    record(database, "0045_org_scope_means_org.sql")
  }],
  ["an earlier baseline", "0001_baseline.sql", (database: Database.Database) => {
    database.exec(BASELINE)
    database.exec("alter table users add column retired_column text")
    record(database, "0001_baseline.sql")
  }],
  ["untracked tables", "none", (database: Database.Database) => database.exec("create table users (user_id text primary key)")],
])("deploy refuses %s before applying any migration", async (_, recorded, seed) => {
  const database = new Database(":memory:")
  try {
    seed(database)
    await expect(deploy(database)).rejects.toThrow(`(recorded migrations: ${recorded}). Its rows cannot be converted: delete it with \`wrangler d1 delete <database>\``)
    expect(applied()).toEqual([])
  } finally {
    database.close()
  }
})

test.each(["empty", "baseline"])("deploy admits a %s database and keeps its rows", async (state) => {
  const database = new Database(":memory:")
  try {
    if (state === "baseline") {
      database.exec(BASELINE)
      record(database, "0001_baseline.sql")
      database.exec("insert into users(user_id, state, created_at, updated_at) values ('keep', 'active', 1, 1)")
    }
    await expect(deploy(database)).rejects.toThrow("auth provisioning starts")
    expect(applied()).toEqual(["AUTH_DB", "CONTROL_PLANE_DB"])
    expect(database.prepare("select name from d1_migrations").all()).toEqual([{ name: "0001_baseline.sql" }])
    expect(database.prepare("select user_id from users").all()).toEqual(state === "baseline" ? [{ user_id: "keep" }] : [])
  } finally {
    database.close()
  }
})
