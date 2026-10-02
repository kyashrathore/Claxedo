import { createRequire } from "node:module"
import { openNativeSqliteDatabase, type SqliteDatabase } from "@claxedo/session-core"

export function openSqliteDatabase(file: string): SqliteDatabase {
  return openNativeSqliteDatabase(createRequire(import.meta.url), file)
}
