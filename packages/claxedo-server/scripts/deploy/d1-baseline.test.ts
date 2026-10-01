import { beforeEach, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import Database from "better-sqlite3"
import { prepareD1Databases } from "./d1-databases"

const wrangler = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock("./wrangler-cli", () => ({ runWrangler: wrangler.run }))
const input = { configArgs: ["--config", "staging.toml"], apiOrigin: "https://api.test", betterAuthSecret: "a".repeat(32), introspectionSecret: "b".repeat(32) }
beforeEach(() => { wrangler.run.mockReset() })

test.each(["0001_service_installations.sql", "0045_org_scope_means_org.sql"])("deploy refuses history containing %s before applying any migrations", async (name) => {
  const database = new Database(":memory:")
  database.exec("create table d1_migrations (id integer primary key, name text); create table old_rows (value text); insert into old_rows values ('keep');")
  database.prepare("insert into d1_migrations(name) values (?)").run(name)
  wrangler.run.mockImplementation(async (args: string[]) => {
    if (args[1] !== "execute" || args[2] !== "CONTROL_PLANE_DB") throw new Error("unexpected mutation before schema admission")
    const sql = args[args.indexOf("--command") + 1]!
    return JSON.stringify([{ success: true, results: database.prepare(sql).all() }])
  })
  try {
    await expect(prepareD1Databases(input)).rejects.toThrow(/bun run d1:reset:staging/)
    expect(wrangler.run.mock.calls.every(([args]) => args[1] === "execute")).toBe(true)
    expect(database.prepare("select * from old_rows").all()).toEqual([{ value: "keep" }])
  } finally {
    database.close()
  }
})

test.each(["empty", "baseline"])("deploy admits a %s database and reaches auth provisioning with baseline tables intact", async (state) => {
  const database = new Database(":memory:")
  const baseline = readFileSync(new URL("../../migrations/control-plane/0001_baseline.sql", import.meta.url), "utf8")
  const install = () => {
    database.exec(baseline)
    database.exec("create table d1_migrations(id integer primary key, name text); insert into d1_migrations(name) values ('0001_baseline.sql')")
  }
  if (state === "baseline") {
    install()
    database.exec("insert into users(user_id, state, created_at, updated_at) values ('keep', 'active', 1, 1)")
  }
  wrangler.run.mockImplementation(async (args: string[]) => {
    if (args[1] === "migrations") {
      if (args[3] === "CONTROL_PLANE_DB" && state === "empty") install()
      return ""
    }
    if (args[2] === "AUTH_DB") throw new Error("auth provisioning starts")
    return JSON.stringify([{ success: true, results: database.prepare(args[args.indexOf("--command") + 1]!).all() }])
  })
  try {
    await expect(prepareD1Databases(input)).rejects.toThrow("auth provisioning starts")
    expect(database.prepare("select name from d1_migrations").all()).toEqual([{ name: "0001_baseline.sql" }])
    expect(database.prepare("select user_id from users").all()).toEqual(state === "baseline" ? [{ user_id: "keep" }] : [])
    expect(wrangler.run.mock.calls.filter(([args]) => args[1] === "migrations").map(([args]) => args[3])).toEqual(["AUTH_DB", "CONTROL_PLANE_DB"])
  } finally {
    database.close()
  }
})
