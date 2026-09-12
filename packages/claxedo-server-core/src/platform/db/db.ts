/**
 * ClaxedoDB — Singleton for the claxedo.db SQLite database.
 *
 * Mirrors the upstream OpenCode Database singleton pattern but manages a separate `claxedo.db` file for claxedo-specific tables:
 * pages, arena, terminal-session, sessions, etc.
 */

import Database from "better-sqlite3"
import { drizzle as drizzleBetter, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3"

export { eq, and, desc, gt, inArray } from "drizzle-orm"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { lazy } from "@claxedo/server-core/platform/runtime/lib/lazy"
import { isJsonRecord, jsonRecord } from "@claxedo/server-core/platform/runtime/lib/json"
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

/**
 * The two untyped modules the Bun path loads.
 *
 * `bun:sqlite` has no types under a Node typecheck, and drizzle's bun-sqlite
 * entry point is only reachable at runtime under Bun. Both are therefore
 * declared here as the contract this module requires and CHECKED at load
 * (`isBunSqliteModule` / `isBunDrizzleModule`) rather than asserted: a Bun
 * upgrade that moves either export fails at the boundary with a message that
 * names it, not later inside a query.
 *
 * `drizzle` is declared as returning `ClaxedoDB.Client`: both driver entry
 * points build the same query builder, and every caller here uses only that
 * shared surface.
 */
type BunSqliteModule = {
  Database: new (file: string) => CompatibleSqlite
}
type BunDrizzleModule = {
  drizzle: (config: { client: CompatibleSqlite }) => ClaxedoDB.Client
}

function isBunSqliteModule(value: unknown): value is BunSqliteModule {
  return isJsonRecord(value) && typeof value.Database === "function"
}

function isBunDrizzleModule(value: unknown): value is BunDrizzleModule {
  return isJsonRecord(value) && typeof value.drizzle === "function"
}
type CompatibleSqlite = {
  exec(sql: string): unknown
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
  }
  /**
   * Wrap `fn` so calling the result runs it inside a transaction.
   *
   * Deliberately not generic over the function type: better-sqlite3 returns a
   * `Transaction<T>` (T plus `.deferred`/`.immediate`/`.exclusive`), which is
   * assignable at the value level but not to a bare `T`. Naming only what every
   * caller uses — a no-argument thunk — makes both drivers fit without an
   * assertion.
   */
  transaction<Result>(fn: () => Result): () => Result
  close(): unknown
  pragma?(sql: string): unknown
}

function bunRuntime() {
  return !!process.versions.bun
}

/** Rows of a raw query, each narrowed to a record. A non-record row is dropped. */
export function queryRows(sqlite: CompatibleSqlite, sql: string, ...params: unknown[]): Record<string, unknown>[] {
  return sqlite.prepare(sql).all(...params).filter(isJsonRecord)
}

/** The one row of a raw query, when it is a record. */
export function queryRow(sqlite: CompatibleSqlite, sql: string, ...params: unknown[]): Record<string, unknown> | undefined {
  return jsonRecord(sqlite.prepare(sql).get(...params))
}

/** A row's text column, when it holds a string. */
export function textColumn(row: Record<string, unknown>, name: string): string | undefined {
  const value = row[name]
  return typeof value === "string" ? value : undefined
}

/** A row's numeric column, when it holds a finite number. */
export function numberColumn(row: Record<string, unknown>, name: string): number | undefined {
  const value = row[name]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** One text column across every row, skipping rows where it is not a string. */
export function textColumns(rows: Record<string, unknown>[], name: string): string[] {
  return rows.map((row) => textColumn(row, name)).filter((value): value is string => value !== undefined)
}

function openDatabase(file: string) {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true })
  if (bunRuntime()) {
    const bun: unknown = require("bun:sqlite")
    const bunDrizzle: unknown = require("drizzle-orm/bun-sqlite")
    if (!isBunSqliteModule(bun)) throw new Error("bun:sqlite does not export a Database constructor")
    if (!isBunDrizzleModule(bunDrizzle)) throw new Error("drizzle-orm/bun-sqlite does not export drizzle")
    const sqlite = new bun.Database(file)
    return { sqlite, db: bunDrizzle.drizzle({ client: sqlite }) }
  }

  const sqlite = new Database(file)
  return { sqlite, db: drizzleBetter({ client: sqlite }) }
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
    textColumns(queryRows(sqlite, `SELECT name FROM __claxedo_migrations`), "name"),
  )
  const ran: string[] = []
  for (const entry of entries) {
    if (applied.has(entry.name)) continue
    const sql = entry.sql()
    sqlite.transaction(() => {
      try {
        sqlite.exec(sql)
      } catch (error) {
        const repairedModelColumns =
          entry.name === "20260712000100_session_meta_model" &&
          textColumns(queryRows(sqlite, "PRAGMA table_info(claxedo_session_meta)"), "name").filter(
            (name) => name === "model_provider_id" || name === "model_id",
          ).length === 2
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
    const rows = queryRows(sqlite, `SELECT name, sql FROM sqlite_master ORDER BY name`)
    const hash = createHash("sha256")
    hash.update(`repair-version:${REPAIR_VERSION}`)
    for (const row of rows) hash.update(`\n${textColumn(row, "name") ?? ""}\n${textColumn(row, "sql") ?? ""}`)
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
    const row = queryRow(sqlite, `SELECT value FROM __claxedo_meta WHERE key = ?`, REPAIR_FINGERPRINT_KEY)
    return row && textColumn(row, "value")
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
    .prepare(
      `INSERT INTO __claxedo_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
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
  export type Client = BetterSQLite3Database

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

    try {
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
    } catch (error) {
      // A refused open fails CLOSED all the way: without this, the handle
      // opened above outlives the throw, and on Windows that leaked handle
      // pins claxedo.db — and therefore the whole data directory — against
      // deletion, with no way for the caller to reach this instance's close().
      try {
        sqlite.close()
      } catch {
        // Closing a handle that never fully opened can itself throw; the
        // original error is the one worth surfacing.
      }
      state.sqlite = undefined
      throw error
    }
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

  export type Sqlite = CompatibleSqlite
  export type Connection = { sqlite: Sqlite; db: Client; close(): void }

  /**
   * A second connection to the same `claxedo.db`, for a module that holds a
   * transaction open across awaits. The shared handle cannot serve that: a
   * `BEGIN` on it captures every other module's writes until the holder
   * commits, and a `BEGIN` while one is already open is an error rather than a
   * nested unit. Callers own what they open and must close it.
   *
   * The shared handle is realized first because it is what applies the
   * migration journal; a connection opened before it would query tables that
   * do not exist yet. An in-memory database has no file for a second
   * connection to reach, so it is refused rather than answered with an empty
   * one.
   */
  export function connect(): Connection {
    Drizzle()
    const file = Path()
    if (file === ":memory:") {
      throw new Error("claxedo database is in memory and cannot be reached by a second connection")
    }
    const opened = openDatabase(file)
    pragma(opened.sqlite, "journal_mode = WAL")
    pragma(opened.sqlite, "synchronous = NORMAL")
    pragma(opened.sqlite, "busy_timeout = 5000")
    pragma(opened.sqlite, "foreign_keys = ON")
    return {
      sqlite: opened.sqlite,
      db: opened.db,
      close: () => void opened.sqlite.close(),
    }
  }

  export function use<T>(callback: (db: Client) => T): T {
    return callback(Drizzle())
  }

  /**
   * Run `callback` inside a synchronous transaction.
   *
   * drizzle >=1.0 types a sync-driver transaction callback's return as
   * `T extends Promise<any> ? DrizzleTypeError : T`, and through this generic
   * seam it cannot prove `T` is not a Promise. Returning nothing from the inner
   * callback resolves that conditional and carries the result out in a cell —
   * which is also the honest shape, since a sync driver genuinely cannot await
   * inside a transaction.
   */
  export function transaction<Result>(callback: (db: Client) => Result): Result {
    const carried: Result[] = []
    Drizzle().transaction((tx) => {
      carried.push(callback(tx))
    })
    return carried[0]
  }
}
