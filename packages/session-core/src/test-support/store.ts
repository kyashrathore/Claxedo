import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { openNativeSqliteDatabase } from "../sqlite/native"
import { RuntimeStore, type RuntimeStoreDatabase } from "../store"

/** A store database in `root` on the engine's native driver, with the connection settings the machine host opens it under. */
export function openTestRuntimeStoreDatabase(root: string): RuntimeStoreDatabase {
  fs.mkdirSync(root, { recursive: true })
  const db = openNativeSqliteDatabase(createRequire(import.meta.url), path.join(root, "state.db"))
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA foreign_keys = ON")
  return { db, location: root, flush: () => db.exec("PRAGMA wal_checkpoint(TRUNCATE)") }
}

export function openTestRuntimeStore(root: string): RuntimeStore {
  const database = openTestRuntimeStoreDatabase(root)
  try {
    return new RuntimeStore(database)
  } catch (error) {
    database.db.close()
    throw error
  }
}
