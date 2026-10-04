import { rmSync } from "node:fs"
import { ClaxedoDB } from "@claxedo/server-core/platform/db/index"
import { closeTasksStore } from "@claxedo/server-core/tasks-host/sqlite-store"

/** NT refuses to unlink an open SQLite file and can briefly retain its lock after close. */
export function removeTestDataDir(directory: string) {
  ClaxedoDB.close()
  closeTasksStore()
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
