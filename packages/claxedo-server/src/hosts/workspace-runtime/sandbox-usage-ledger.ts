import { mkdirSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { openNativeSqliteDatabase } from "@claxedo/session-core"
import { createRuntimeUsageLedger, type RuntimeUsageLedger } from "@claxedo/server-core/usage/runtime-usage-ledger"

/** The sandbox runtime's usage ledger, in its store directory so a restarted runtime still reports what it metered before. */
export function openSandboxUsageLedger(input: { path: string; workspaceId: string }): RuntimeUsageLedger {
  mkdirSync(path.dirname(input.path), { recursive: true })
  const db = openNativeSqliteDatabase(createRequire(import.meta.url), input.path)
  db.exec("pragma journal_mode = WAL")
  return createRuntimeUsageLedger({ db, workspaceId: () => input.workspaceId })
}
