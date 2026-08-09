import { asc } from "drizzle-orm"
import { ClaxedoDB } from "../../platform/db"
import { ClaxedoUsageSourceCoverageTable } from "../usage.sql"

type Database = { use<T>(callback: (db: ClaxedoDB.Client) => T): T }

export type UsageSourceCoverageStore = {
  ensure(sources: readonly string[]): Promise<void>
  starts(): Promise<Record<string, number>>
}

/** Persist the fail-closed boundary once; restarts must never move it forward. */
export function createSqliteUsageSourceCoverageStore(input: {
  database?: Database
  now?: () => number
} = {}): UsageSourceCoverageStore {
  const database = input.database ?? ClaxedoDB
  const now = input.now ?? Date.now
  return {
    async ensure(sources) {
      const startedAt = now()
      database.use((db) => {
        for (const source of new Set(sources.map((value) => value.trim()).filter(Boolean))) {
          db.insert(ClaxedoUsageSourceCoverageTable)
            .values({ source, started_at: startedAt })
            .onConflictDoNothing()
            .run()
        }
      })
    },
    async starts() {
      const rows = database.use((db) => db.select().from(ClaxedoUsageSourceCoverageTable)
        .orderBy(asc(ClaxedoUsageSourceCoverageTable.source)).all())
      return Object.fromEntries(rows.map((row) => [row.source, row.started_at]))
    },
  }
}
