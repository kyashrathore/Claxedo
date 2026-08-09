import Database from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { describe, expect, test } from "vitest"
import { createSqliteUsageSourceCoverageStore } from "./sqlite-usage-provenance"

function harness(now: () => number) {
  const sqlite = new Database(":memory:")
  sqlite.exec("CREATE TABLE claxedo_usage_source_coverage (source TEXT PRIMARY KEY NOT NULL, started_at INTEGER NOT NULL)")
  const db = drizzle({ client: sqlite })
  return createSqliteUsageSourceCoverageStore({
    database: { use: <T>(callback: (client: typeof db) => T) => callback(db) } as never,
    now,
  })
}

describe("sqlite usage provenance coverage", () => {
  test("pins the first complete boundary across later starts", async () => {
    let now = 100
    const store = harness(() => now)
    await store.ensure(["claude", "codex"])
    now = 200
    await store.ensure(["claude", "pi"])
    expect(await store.starts()).toEqual({ claude: 100, codex: 100, pi: 200 })
  })
})
