import Database from "better-sqlite3"
import { describe, expect, test } from "vitest"
import { currentControlPlaneBaseline } from "../../../../scripts/control-plane-schema"

describe("the shipped control-plane schema", () => {
  test("has no account agent settings table and retains the task start policy columns", () => {
    const database = new Database(":memory:")
    try {
      database.exec(currentControlPlaneBaseline())
      const settingsTables = () => database.prepare(
        "select name from sqlite_master where type = 'table' and name like '%_agent_settings'",
      ).all()
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
