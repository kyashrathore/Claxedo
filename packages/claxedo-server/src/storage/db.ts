/**
 * ClaxedoDB — Singleton for the claxedo.db SQLite database.
 *
 * Mirrors the upstream Database pattern (packages/opencode/src/storage/db.ts)
 * but manages a separate `claxedo.db` file for claxedo-specific tables:
 * pages, arena, terminal-session, sessions, etc.
 */

import Database from "better-sqlite3"
import { drizzle as drizzleBetter, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3"

export { eq, and, desc, gt, inArray } from "drizzle-orm"
import { dataDir } from "../paths"
import { Log } from "../log"
import { lazy } from "../lazy"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import { createRequire } from "module"
import * as schema from "./schema"
import { repair } from "./repair"

declare const CLAXEDO_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

const log = Log.create({ service: "claxedo-db" })
const require = createRequire(import.meta.url)

type Sqlite = InstanceType<typeof Database>
type BunSqliteModule = typeof import("bun:sqlite")
type BunDrizzleModule = typeof import("drizzle-orm/bun-sqlite")
type CompatibleSqlite = {
  exec(sql: string): unknown
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
  }
  transaction<T extends (...args: never[]) => unknown>(fn: T): T
  close(): unknown
  pragma?(sql: string): unknown
}

function bunRuntime() {
  return !!process.versions.bun
}

function openDatabase(file: string) {
  if (bunRuntime()) {
    const bun = require("bun:sqlite") as BunSqliteModule
    const drizzle = (require("drizzle-orm/bun-sqlite") as BunDrizzleModule).drizzle
    const sqlite = new bun.Database(file)
    return {
      sqlite: sqlite as CompatibleSqlite,
      db: drizzle({ client: sqlite, schema }) as unknown as BetterSQLite3Database<typeof schema>,
    }
  }

  const sqlite = new Database(file)
  return {
    sqlite: sqlite as CompatibleSqlite,
    db: drizzleBetter({ client: sqlite, schema }),
  }
}

function pragma(sqlite: CompatibleSqlite, sql: string) {
  if (sqlite.pragma) {
    sqlite.pragma(sql)
    return
  }
  sqlite.exec(`PRAGMA ${sql}`)
}

/** Run pending SQL migrations on the raw sqlite instance using a simple tracking table. */
function applyMigrations(sqlite: CompatibleSqlite, entries: { sql: string; timestamp: number; name: string }[]) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS __claxedo_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
  const applied = new Set(
    (sqlite.prepare(`SELECT name FROM __claxedo_migrations`).all() as { name: string }[]).map((r) => r.name),
  )
  for (const entry of entries) {
    if (applied.has(entry.name)) continue
    sqlite.transaction(() => {
      try {
        sqlite.exec(entry.sql)
      } catch (error) {
        const repairedModelColumns = entry.name === "20260712000100_session_meta_model"
          && (sqlite.prepare("PRAGMA table_info(claxedo_session_meta)").all() as { name?: unknown }[])
            .filter((item): item is { name: string } => typeof item.name === "string")
            .map((item) => item.name)
            .filter((name) => name === "model_provider_id" || name === "model_id").length === 2
        if (!repairedModelColumns) throw error
      }
      sqlite.prepare(`INSERT INTO __claxedo_migrations (name, applied_at) VALUES (?, ?)`).run(entry.name, Date.now())
    })()
  }
}

export namespace ClaxedoDB {
  export function Path() {
    const dir = dataDir()
    if (dir === ":memory:") return dir
    return path.join(dir, "claxedo.db")
  }

  type Schema = typeof schema
  export type Client = BetterSQLite3Database<Schema>

  type Journal = { sql: string; timestamp: number; name: string }[]

  const state = {
    sqlite: undefined as CompatibleSqlite | undefined,
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

    const { sqlite, db } = openDatabase(Path())
    state.sqlite = sqlite

    pragma(sqlite, "journal_mode = WAL")
    pragma(sqlite, "synchronous = NORMAL")
    pragma(sqlite, "busy_timeout = 5000")
    pragma(sqlite, "cache_size = -64000")
    pragma(sqlite, "foreign_keys = ON")
    sqlite.exec("PRAGMA wal_checkpoint(PASSIVE)")

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

    const fixed = (() => {
      try {
        return repair(sqlite)
      } catch (error) {
        log.error("failed to repair claxedo schema", { error: String(error) })
        throw error
      }
    })()
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
  export function raw(): CompatibleSqlite {
    Drizzle() // ensure initialized
    return state.sqlite!
  }

  export function use<T>(callback: (db: Client) => T): T {
    return callback(Drizzle())
  }

  export function transaction<T>(callback: (db: Client) => T): T {
    const db = Drizzle()
    // drizzle >=1.0 types sync-driver transaction callbacks as `T extends
    // Promise<any> ? DrizzleTypeError : T`; the casts keep the generic
    // signature callers rely on (callers here are synchronous).
    const run = (tx: unknown) => callback(tx as Client)
    return db.transaction(run as never) as T
  }
}
