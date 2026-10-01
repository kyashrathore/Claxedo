import { readFileSync, readdirSync } from "node:fs"
import Database from "better-sqlite3"
import { expect, test } from "vitest"

test("the deployed control-plane schema has no participant table, index or trigger", () => {
  const db = new Database(":memory:")
  try {
    const directory = new URL("../../../../migrations/control-plane/", import.meta.url)
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      db.exec(readFileSync(new URL(name, directory), "utf8"))
    }
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%participant%'").all()).toEqual([])
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([])
  } finally {
    db.close()
  }
})
