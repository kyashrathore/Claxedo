import { readdirSync, readFileSync } from "node:fs"
import Database from "better-sqlite3"
import { describe, expect, test } from "vitest"

const migrations = new URL("../../../../migrations/control-plane/", import.meta.url)

describe("the shipped control-plane schema", () => {
  test("has no account agent settings table and retains the task start policy columns", () => {
    const database = new Database(":memory:")
    try {
      for (const name of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
        database.exec(readFileSync(new URL(name, migrations), "utf8"))
      }
      const settingsTables = () => database.prepare(
        "select name from sqlite_master where type = 'table' and name like '%_agent_settings'",
      ).all()
      expect(settingsTables()).toEqual([])
      const retirement = readFileSync(new URL("0051_drop_account_agent_setting.sql", migrations), "utf8")
      const table = retirement.match(/^drop table if exists (\w+);\s*$/)?.[1]
      expect(table).toBeDefined()
      database.exec(`create table ${table} (user_id text primary key, cross_machine_writes integer)`)
      database.prepare(`insert into ${table} values (?, ?)`).run("user-a", 1)
      database.exec(retirement)
      expect(settingsTables()).toEqual([])
      const columns = (table: string) => database.prepare(`pragma table_info(${table})`)
        .all().map((column) => (column as { name: string }).name)
      expect(columns("task_presets")).toContain("agent_startable")
      expect(columns("task_session_links")).toEqual(expect.arrayContaining([
        "started_from_session_id", "started_from_workspace_id", "placement", "started_by",
      ]))
    } finally {
      database.close()
    }
  })
})
