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
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { lazy } from "@claxedo/server-core/platform/runtime/lib/lazy"
import path from "path"
import { readFileSync, readdirSync, existsSync, mkdirSync } from "fs"
import { createRequire } from "module"
import { createHash } from "crypto"

import { repair, REPAIR_VERSION } from "./repair"

declare const CLAXEDO_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

/**
 * Where this deployment's migration journal lives.
 *
 * The journal is PRODUCT schema — documents, credentials, connections,
 * channels — so the product supplies it rather than the database engine
 * carrying it. Resolving it from this module's own directory only worked while
 * engine and journal shipped together.
 *
 * There is no default. An unconfigured database would apply zero migrations and
 * hand back a working handle to a file with no tables, which is a failure this
 * product has shipped before: every query fails later, somewhere else, for a
 * reason the stack trace does not name.
 */
let migrationsDir: string | undefined

export function configureClaxedoMigrations(dir: string) {
  migrationsDir = dir
}

const log = Log.create({ service: "claxedo-db" })
const require = createRequire(import.meta.url)

type Sqlite = InstanceType<typeof Database>
type BunSqliteModule = {
  Database: new (file: string) => CompatibleSqlite
}
type BunDrizzleModule = {
  drizzle: (config: { client: CompatibleSqlite }) => unknown
}
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
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true })
  if (bunRuntime()) {
    const bun = require("bun:sqlite") as BunSqliteModule
    const drizzle = (require("drizzle-orm/bun-sqlite") as BunDrizzleModule).drizzle
    const sqlite = new bun.Database(file)
    return {
      sqlite: sqlite as CompatibleSqlite,
      db: drizzle({ client: sqlite }) as unknown as ClaxedoDB.Client,
    }
  }

  const sqlite = new Database(file)
  return {
    sqlite: sqlite as CompatibleSqlite,
    db: drizzleBetter({ client: sqlite }) as unknown as ClaxedoDB.Client,
  }
}

function pragma(sqlite: CompatibleSqlite, sql: string) {
  if (sqlite.pragma) {
    sqlite.pragma(sql)
    return
  }
  sqlite.exec(`PRAGMA ${sql}`)
}

/**
 * One migration in journal order. `sql` is a thunk so the journal can be
 * enumerated (names + order) without materializing every migration's SQL: on a
 * warm boot every entry is already applied and no SQL is ever needed, so the
 * dev/disk journal skips 37 file reads and the bundled journal costs nothing
 * either way.
 */
type MigrationEntry = { sql: () => string; timestamp: number; name: string }

/**
 * Run pending SQL migrations on the raw sqlite instance using a simple
 * tracking table. Consults the journal first and loads an entry's SQL only
 * when it is not yet applied. Returns the names it applied, in order.
 */
function applyMigrations(sqlite: CompatibleSqlite, entries: MigrationEntry[]) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS __claxedo_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
  const applied = new Set(
    (sqlite.prepare(`SELECT name FROM __claxedo_migrations`).all() as { name: string }[]).map((r) => r.name),
  )
  const ran: string[] = []
  for (const entry of entries) {
    if (applied.has(entry.name)) continue
    const sql = entry.sql()
    sqlite.transaction(() => {
      try {
        sqlite.exec(sql)
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
    ran.push(entry.name)
  }
  return ran
}

/**
 * Boot-time gate for `repair`: a hash of the live schema (every
 * `sqlite_master` row) plus the repair routine's own version. When the stored
 * fingerprint from the last completed repair still matches, the schema has not
 * drifted and repair's ~70 statements (including two full-table UPDATE
 * backfills) are skipped. Any failure to compute returns undefined, which the
 * caller treats as "run repair" — the gate fails open because repair exists
 * precisely for databases in unexpected states.
 */
function schemaFingerprint(sqlite: CompatibleSqlite): string | undefined {
  try {
    const rows = sqlite.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all() as {
      name: string
      sql: string | null
    }[]
    const hash = createHash("sha256")
    hash.update(`repair-version:${REPAIR_VERSION}`)
    for (const row of rows) hash.update(`\n${row.name}\n${row.sql ?? ""}`)
    return hash.digest("hex")
  } catch (error) {
    log.warn("failed to fingerprint claxedo schema", { error: String(error) })
    return undefined
  }
}

const REPAIR_FINGERPRINT_KEY = "repair_fingerprint"

function ensureMetaTable(sqlite: CompatibleSqlite) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS __claxedo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
}

/** Fingerprint persisted by the last completed repair; undefined (→ repair runs) when absent or unreadable. */
function storedRepairFingerprint(sqlite: CompatibleSqlite): string | undefined {
  try {
    ensureMetaTable(sqlite)
    const row = sqlite.prepare(`SELECT value FROM __claxedo_meta WHERE key = ?`).get(REPAIR_FINGERPRINT_KEY) as
      | { value?: unknown }
      | undefined
    return typeof row?.value === "string" ? row.value : undefined
  } catch (error) {
    log.warn("failed to read claxedo repair fingerprint", { error: String(error) })
    return undefined
  }
}

function storeRepairFingerprint(sqlite: CompatibleSqlite, fingerprint: string | undefined) {
  ensureMetaTable(sqlite)
  if (fingerprint === undefined) {
    // Could not fingerprint the repaired schema: leave no stale record so the
    // next boot fails open into another repair pass.
    sqlite.prepare(`DELETE FROM __claxedo_meta WHERE key = ?`).run(REPAIR_FINGERPRINT_KEY)
    return
  }
  sqlite
    .prepare(`INSERT INTO __claxedo_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(REPAIR_FINGERPRINT_KEY, fingerprint)
}

export namespace ClaxedoDB {
  export function Path() {
    const dir = dataDir()
    if (dir === ":memory:") return dir
    return path.join(dir, "claxedo.db")
  }

  // Deliberately schema-less. Drizzle's schema generic types only its
  // relational query builder (`db.query.*`), which nothing in this repository
  // uses — every call site passes its table explicitly. Naming the schema here
  // pulled `platform/db/schema.ts`, the barrel of every PRODUCT table
  // (connections, channels, documents), into the closure of every module that
  // opens the database. The barrel stays where the product tables are, as the
  // migration generator's input; this module knows nothing about them.
  export type Client = BetterSQLite3Database<Record<string, never>>

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

  function migrations(dir: string): MigrationEntry[] {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(path.join(dir, name, "migration.sql")))
      .map((name) => ({
        name,
        timestamp: time(name),
        // Read on demand: applyMigrations only pulls the SQL for entries the
        // journal has not applied yet, so a warm boot lists the directory and
        // reads zero migration files. A file that vanishes between listing and
        // a pending apply still fails loudly here.
        sql: () => readFileSync(path.join(dir, name, "migration.sql"), "utf-8"),
      }))
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  /**
   * Fail closed. A bundled journal wins; otherwise the product must have named
   * its directory, and that directory must actually hold migrations. Returning
   * an empty list here would open an empty database and report success.
   */
  function resolveMigrations(): MigrationEntry[] {
    if (typeof CLAXEDO_MIGRATIONS !== "undefined")
      return CLAXEDO_MIGRATIONS.map((entry) => ({
        name: entry.name,
        timestamp: entry.timestamp,
        sql: () => entry.sql,
      }))
    if (!migrationsDir) {
      throw new Error(
        "claxedo database opened before its migration journal was configured; call configureClaxedoMigrations(dir) from the composition that owns the schema",
      )
    }
    const entries = migrations(migrationsDir)
    if (entries.length === 0) {
      throw new Error(`claxedo migration journal at ${migrationsDir} is empty or missing`)
    }
    return entries
  }

  export const Drizzle = lazy(() => {
    log.info("opening claxedo database", { path: Path() })

    const { sqlite, db } = openDatabase(Path())
    state.sqlite = sqlite

    pragma(sqlite, "journal_mode = WAL")
    pragma(sqlite, "synchronous = NORMAL")
    pragma(sqlite, "busy_timeout = 5000")
    pragma(sqlite, "cache_size = -8000")
    pragma(sqlite, "foreign_keys = ON")
    sqlite.exec("PRAGMA wal_checkpoint(PASSIVE)")

    const entries = resolveMigrations()
    const applied = applyMigrations(sqlite, entries)
    if (applied.length > 0) {
      log.info("applied claxedo migrations", {
        count: applied.length,
        mode: typeof CLAXEDO_MIGRATIONS !== "undefined" ? "bundled" : "dev",
      })
    }

    // Repair heals drifted schemas, but on a healthy warm boot its ~70
    // statements (DDL probes plus two full-table UPDATE backfills) are pure
    // overhead. Skip it only when the persisted fingerprint from the last
    // completed repair matches the live schema AND no migration just ran;
    // every uncertain state (absent fingerprint, unreadable meta table,
    // fingerprint mismatch) fails open into a full repair pass.
    const stored = storedRepairFingerprint(sqlite)
    const current = schemaFingerprint(sqlite)
    if (applied.length > 0 || stored === undefined || current === undefined || stored !== current) {
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
      // Repair itself may have altered the schema; persist what it left behind.
      storeRepairFingerprint(sqlite, schemaFingerprint(sqlite))
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
