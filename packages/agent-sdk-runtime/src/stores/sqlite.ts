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

/** @internal */
export class SqliteRuntimeStore extends MemoryRuntimeStore {
  private db: SqliteDatabase
  private hydrating = true

  constructor(options: SqliteRuntimeStoreOptions) {
    super()
    fs.mkdirSync(options.root, { recursive: true, mode: 0o755 })
    this.db = openDatabase(path.join(options.root, "agent-runtime.db"))
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
    this.persist()
    this.db.close?.()
  }

  protected override afterChange() {
    if (!this.hydrating) this.persist()
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
