/**
 * ClaxedoDB — Singleton for the claxedo.db SQLite database.
 *
 * Mirrors the upstream Database pattern (packages/opencode/src/storage/db.ts)
 * but manages a separate `claxedo.db` file for claxedo-specific tables:
 * pages, arena, and tab-context.
 */

import Database from "better-sqlite3"
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3"

export { eq, and, desc, inArray } from "drizzle-orm"
import { dataDir } from "../paths"
import { Log } from "../log"
import { lazy } from "../lazy"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import * as schema from "./schema"
import { repair } from "./repair"

declare const CLAXEDO_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

const log = Log.create({ service: "claxedo-db" })

/** Run pending SQL migrations on the raw sqlite instance using a simple tracking table. */
function applyMigrations(sqlite: InstanceType<typeof Database>, entries: { sql: string; timestamp: number; name: string }[]) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS __claxedo_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
  const applied = new Set(
    (sqlite.prepare(`SELECT name FROM __claxedo_migrations`).all() as { name: string }[]).map((r) => r.name),
  )
  for (const entry of entries) {
    if (applied.has(entry.name)) continue
    sqlite.transaction(() => {
      sqlite.exec(entry.sql)
      sqlite.prepare(`INSERT INTO __claxedo_migrations (name, applied_at) VALUES (?, ?)`).run(entry.name, Date.now())
    })()
  }
}

export namespace ClaxedoDB {
  export function Path() {
    return path.join(dataDir(), "claxedo.db")
  }

  type Schema = typeof schema
  export type Client = BetterSQLite3Database<Schema>

  type Journal = { sql: string; timestamp: number; name: string }[]

  const state = {
    sqlite: undefined as InstanceType<typeof Database> | undefined,
  }

  function time(tag: string) {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
    if (!match) return 0
    return Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    )
  }

  function migrations(dir: string): Journal {
    if (!existsSync(dir)) return []
    const dirs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)

    const sql = dirs
      .map((name) => {
        const file = path.join(dir, name, "migration.sql")
        if (!existsSync(file)) return
        return {
          sql: readFileSync(file, "utf-8"),
          timestamp: time(name),
          name,
        }
      })
      .filter(Boolean) as Journal

    return sql.sort((a, b) => a.timestamp - b.timestamp)
  }

  export const Drizzle = lazy(() => {
    log.info("opening claxedo database", { path: Path() })

    const sqlite = new Database(Path())
    state.sqlite = sqlite

    sqlite.pragma("journal_mode = WAL")
    sqlite.pragma("synchronous = NORMAL")
    sqlite.pragma("busy_timeout = 5000")
    sqlite.pragma("cache_size = -64000")
    sqlite.pragma("foreign_keys = ON")
    sqlite.exec("PRAGMA wal_checkpoint(PASSIVE)")

    const db = drizzle(sqlite, { schema })

    const entries =
      typeof CLAXEDO_MIGRATIONS !== "undefined"
        ? CLAXEDO_MIGRATIONS
        : migrations(path.join(import.meta.dirname, "claxedo-migration"))
    if (entries.length > 0) {
      log.info("applying claxedo migrations", {
        count: entries.length,
        mode: typeof CLAXEDO_MIGRATIONS !== "undefined" ? "bundled" : "dev",
      })
      applyMigrations(sqlite, entries)
    }

    const fixed = repair(sqlite)
    if (fixed.length > 0) {
      log.warn("repaired claxedo schema", {
        fixed,
      })
    }

    return db
  })

  export function close() {
    const sqlite = state.sqlite
    if (!sqlite) return
    sqlite.close()
    state.sqlite = undefined
    Drizzle.reset()
  }

  /** Get the raw better-sqlite3 instance (for legacy queries during migration). */
  export function raw(): InstanceType<typeof Database> {
    Drizzle() // ensure initialized
    return state.sqlite!
  }

  export function use<T>(callback: (db: Client) => T): T {
    return callback(Drizzle())
  }

  export function transaction<T>(callback: (db: Client) => T): T {
    const db = Drizzle()
    return (db.transaction as any)((tx: Client) => callback(tx))
  }
}
