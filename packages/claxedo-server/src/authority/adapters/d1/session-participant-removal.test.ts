import Database from "better-sqlite3"
import { expect, test } from "vitest"
import { currentControlPlaneBaseline } from "../../../../scripts/control-plane-schema"

test("the deployed control-plane schema has no participant table, index or trigger", () => {
  const db = new Database(":memory:")
  try {
    db.exec(currentControlPlaneBaseline())
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%participant%'").all()).toEqual([])
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([])
  } finally {
    db.close()
  }
})
