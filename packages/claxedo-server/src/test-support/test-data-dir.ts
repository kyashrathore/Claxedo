import { rmSync } from "node:fs"
import { closeAuthorityDatabases } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeTasksStore } from "@claxedo/server-core/tasks-host/sqlite-store"

/**
 * Releases every SQLite file a test's data directory may still hold open, then
 * removes the directory. A composition keeps its authority handle private and
 * the Tasks store keeps its own connection, so only their own closers reach
 * them; NT refuses to delete an open file where POSIX unlinks it, and a
 * just-closed one stays locked briefly, hence the retry.
 */
export function removeTestDataDir(directory: string) {
  ClaxedoDB.close()
  closeAuthorityDatabases()
  closeTasksStore()
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
