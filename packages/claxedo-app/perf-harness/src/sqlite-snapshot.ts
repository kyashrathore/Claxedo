import { rm } from "node:fs/promises"
import type { Database } from "bun:sqlite"

export async function checkpointAndCloseSqliteSnapshot(databasePath: string, database: Database) {
  const checkpoint = (() => {
    try {
      return database.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
        busy: number
        log: number
        checkpointed: number
      }
    } finally {
      database.close()
    }
  })()
  if (checkpoint.busy !== 0 || checkpoint.log !== 0) {
    throw new Error(`SQLite database did not quiesce for snapshot: ${JSON.stringify(checkpoint)}`)
  }
  await Promise.all([
    rm(`${databasePath}-wal`, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
  ])
}
