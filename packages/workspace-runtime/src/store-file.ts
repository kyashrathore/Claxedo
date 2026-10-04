import fs from "node:fs"
import path from "node:path"
import { workspaceRuntimeStoreDir } from "./env"
import { openSqliteDatabase } from "./sqlite/node"
import { RuntimeStore, type RuntimeStoreDatabase } from "@claxedo/session-core"

export function openRuntimeStoreDatabase(root: string): RuntimeStoreDatabase {
  fs.mkdirSync(root, { recursive: true, mode: 0o755 })
  const db = openSqliteDatabase(path.join(root, "state.db"))
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  db.exec("PRAGMA busy_timeout = 5000")
  db.exec("PRAGMA foreign_keys = ON")
  return {
    db,
    location: root,
    flush: () => db.exec("PRAGMA wal_checkpoint(TRUNCATE)"),
  }
}

export function openRuntimeStore(root = workspaceRuntimeStoreDir()): RuntimeStore {
  const database = openRuntimeStoreDatabase(root)
  try {
    return new RuntimeStore(database)
  } catch (error) {
    database.db.close()
    throw error
  }
}

/**
 * A runtime that is its own placement authority: an explicit-id create is
 * checked against the execution bindings of the store the host opens. The
 * store opens on the host's first request, so its schema refusal reaches that
 * request rather than the process.
 */
export function storeBackedSessionPlacement() {
  let store: RuntimeStore | undefined
  return {
    storeFactory: ({ storeRoot }: { storeRoot?: string }) => (store = openRuntimeStore(storeRoot)),
    sessionIdWorkspace: (sessionId: string) => store?.getExecutionBinding(sessionId)?.workspaceId,
  }
}
