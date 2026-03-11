/**
 * ClaxedoDB — Singleton for the claxedo.db SQLite database.
 *
 * Mirrors the upstream Database pattern (packages/opencode/src/storage/db.ts)
 * but manages a separate `claxedo.db` file for claxedo-specific tables:
 * pages, arena, and tab-context.
 */

import { Database as BunDatabase } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
export { eq, and, desc, inArray } from "drizzle-orm"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { lazy } from "@/util/lazy"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import * as schema from "./claxedo/schema"
import { repair } from "./claxedo-repair"

declare const CLAXEDO_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

const log = Log.create({ service: "claxedo-db" })

export namespace ClaxedoDB {
  export const Path = path.join(Global.Path.data, "claxedo.db")

  type Schema = typeof schema
  export type Client = SQLiteBunDatabase<Schema>

  type Journal = { sql: string; timestamp: number; name: string }[]

  const state = {
    sqlite: undefined as BunDatabase | undefined,
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
    log.info("opening claxedo database", { path: Path })

    const sqlite = new BunDatabase(Path, { create: true })
    state.sqlite = sqlite

    sqlite.run("PRAGMA journal_mode = WAL")
    sqlite.run("PRAGMA synchronous = NORMAL")
    sqlite.run("PRAGMA busy_timeout = 5000")
    sqlite.run("PRAGMA cache_size = -64000")
    sqlite.run("PRAGMA foreign_keys = ON")
    sqlite.run("PRAGMA wal_checkpoint(PASSIVE)")

    const db = drizzle({ client: sqlite, schema })

    const entries =
      typeof CLAXEDO_MIGRATIONS !== "undefined"
        ? CLAXEDO_MIGRATIONS
        : migrations(path.join(import.meta.dirname, "claxedo-migration"))
    if (entries.length > 0) {
      log.info("applying claxedo migrations", {
        count: entries.length,
        mode: typeof CLAXEDO_MIGRATIONS !== "undefined" ? "bundled" : "dev",
      })
      migrate(db, entries)
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

  /** Get the raw bun:sqlite instance (for legacy queries during migration). */
  export function raw(): BunDatabase {
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
