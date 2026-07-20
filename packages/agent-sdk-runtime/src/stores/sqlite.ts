import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { MemoryRuntimeStore, type MemoryRuntimeStoreSnapshot } from "./memory"
import type { AgentRuntimeStore } from "../runtime"

type SqliteStatement = {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
}

type SqliteDatabase = {
  exec(sql: string): unknown
  prepare(sql: string): SqliteStatement
  close?: () => unknown
}

export type SqliteRuntimeStoreOptions = {
  root: string
}

const requireDatabase = createRequire(import.meta.url)

function openDatabase(file: string): SqliteDatabase {
  if (process.versions.bun) {
    const mod = requireDatabase("bun:sqlite") as { Database: new(file: string) => SqliteDatabase }
    return new mod.Database(file)
  }
  const mod = requireDatabase("better-sqlite3") as
    | { default?: new(file: string) => SqliteDatabase }
    | (new(file: string) => SqliteDatabase)
  const BetterSqlite = typeof mod === "function" ? mod : mod.default
  if (!BetterSqlite) {
    throw new Error("better-sqlite3 export missing; install better-sqlite3 to use @claxedo/agent-sdk-runtime/stores/sqlite outside Bun")
  }
  return new BetterSqlite(file)
}

// persist() serializes the whole store, so its cost grows with total history. Coalescing
// changes behind a trailing timer bounds disk writes to at most one snapshot per interval
// even while a turn streams hundreds of part events.
const FLUSH_COALESCE_MS = 250

/** @internal */
export class SqliteRuntimeStore extends MemoryRuntimeStore {
  private db: SqliteDatabase
  private hydrating = true
  private dirty = false
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushError: unknown = null

  constructor(options: SqliteRuntimeStoreOptions) {
    super()
    fs.mkdirSync(options.root, { recursive: true, mode: 0o755 })
    this.db = openDatabase(path.join(options.root, "agent-runtime.db"))
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA synchronous = NORMAL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_store_snapshot (
        id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `)
    const row = this.db
      .prepare("SELECT data_json FROM runtime_store_snapshot WHERE id = 'state'")
      .get() as { data_json: string } | null
    if (row) this.importSnapshot(JSON.parse(row.data_json) as Partial<MemoryRuntimeStoreSnapshot>)
    this.hydrating = false
  }

  override close() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flushNow()
    this.db.close?.()
  }

  protected override afterChange() {
    if (this.hydrating) return
    this.dirty = true
    this.scheduleFlush()
    if (this.flushError) {
      const error = this.flushError
      this.flushError = null
      throw error
    }
  }

  private scheduleFlush() {
    if (this.flushTimer) return
    const timer = setTimeout(() => {
      this.flushTimer = null
      try {
        this.flushNow()
      } catch (error) {
        // A timer has no caller to throw to; surface the failure on the next store write.
        this.flushError = error
      }
    }, FLUSH_COALESCE_MS)
    timer.unref?.()
    this.flushTimer = timer
  }

  private flushNow() {
    if (!this.dirty) return
    this.persist()
    this.dirty = false
  }

  private persist() {
    this.db.prepare(`
      INSERT OR REPLACE INTO runtime_store_snapshot (id, data_json, updated_at)
      VALUES ('state', ?, ?)
    `).run(JSON.stringify(this.exportSnapshot()), Date.now())
  }
}

export function createSqliteRuntimeStore(options: SqliteRuntimeStoreOptions): AgentRuntimeStore {
  return new SqliteRuntimeStore(options) as unknown as AgentRuntimeStore
}
