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
const WRANGLER_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS "d1_migrations"(
\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,
\t\tname       TEXT UNIQUE,
\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`

function record(database: Database.Database, name: string) {
  database.exec(WRANGLER_MIGRATIONS_TABLE)
  database.prepare(`INSERT INTO "d1_migrations" (name) values (?)`).run(name)
}

function remote(database: Database.Database, onApply: (binding: string) => void = () => {}) {
  wrangler.run.mockImplementation(async (args: string[]) => {
    if (args[1] === "migrations") {
      onApply(args[3]!)
      return ""
    }
    if (args[1] !== "execute" || args[2] !== "CONTROL_PLANE_DB") throw new Error("auth provisioning starts")
    return JSON.stringify([{ success: true, results: database.prepare(args[args.indexOf("--command") + 1]!).all() }])
  })
}

const applied = () => wrangler.run.mock.calls.filter(([args]) => args[1] === "migrations").map(([args]) => args[3])

test.each(["0001_service_installations.sql", "0045_org_scope_means_org.sql"])("deploy refuses history containing %s before applying any migrations", async (name) => {
  const database = new Database(":memory:")
  try {
    database.exec("create table old_rows (value text); insert into old_rows values ('keep');")
    record(database, name)
    remote(database)
    await expect(prepareD1Databases(input)).rejects.toThrow(`Control-plane D1 has pre-baseline migrations: ${name}. Reset staging with bun run d1:reset:staging`)
    expect(applied()).toEqual([])
    expect(database.prepare("select * from old_rows").all()).toEqual([{ value: "keep" }])
  } finally {
    database.close()
  }
})

test("deploy refuses a database whose recorded baseline is not the current one", async () => {
  const database = new Database(":memory:")
  try {
    database.exec(BASELINE)
    database.exec("alter table users add column retired_column text")
    record(database, "0001_baseline.sql")
    remote(database)
    await expect(prepareD1Databases(input)).rejects.toThrow(/different schema than the current 0001_baseline.sql.*bun run d1:reset:staging/)
    expect(applied()).toEqual([])
  } finally {
    database.close()
  }
})

test("deploy refuses an untracked schema", async () => {
  const database = new Database(":memory:")
  try {
    database.exec("create table users (user_id text primary key)")
    remote(database)
    await expect(prepareD1Databases(input)).rejects.toThrow(/untracked schema.*bun run d1:reset:staging/)
    expect(applied()).toEqual([])
  } finally {
    database.close()
  }
})

test.each(["empty", "baseline"])("deploy admits a %s database and reaches auth provisioning with baseline tables intact", async (state) => {
  const database = new Database(":memory:")
  const install = () => {
    database.exec(BASELINE)
    record(database, "0001_baseline.sql")
  }
  if (state === "baseline") {
    install()
    database.exec("insert into users(user_id, state, created_at, updated_at) values ('keep', 'active', 1, 1)")
  }
  remote(database, (binding) => { if (binding === "CONTROL_PLANE_DB" && state === "empty") install() })
  try {
    await expect(prepareD1Databases(input)).rejects.toThrow("auth provisioning starts")
    expect(database.prepare("select name from d1_migrations").all()).toEqual([{ name: "0001_baseline.sql" }])
    expect(database.prepare("select user_id from users").all()).toEqual(state === "baseline" ? [{ user_id: "keep" }] : [])
    expect(applied()).toEqual(["AUTH_DB", "CONTROL_PLANE_DB"])
  } finally {
    database.close()
  }
})
