import { isRecord } from "@claxedo/helpers/guards"
import type { SqliteDatabase, SqliteRunResult } from "./database"

type NativeStatement<Row> = {
  run(...params: unknown[]): SqliteRunResult
  get(...params: unknown[]): Row | null | undefined
  all(...params: unknown[]): Row[]
  finalize?: () => unknown
}

type NativeTransaction = { immediate(): unknown }

type NativeDatabase = {
  exec(sql: string): unknown
  prepare<Row>(sql: string): NativeStatement<Row>
  transaction(run: () => unknown): NativeTransaction
  close(throwOnError?: boolean): unknown
}

type NativeDatabaseConstructor = new (file: string) => NativeDatabase

/**
 * Both drivers are loaded through the caller's `require` (never bundled), so
 * their exports arrive untyped. This is the one place that decides a value is a
 * database constructor, and it decides it by looking, not by asserting.
 */
function isNativeDatabaseConstructor(value: unknown): value is NativeDatabaseConstructor {
  return typeof value === "function"
}

function nativeConstructor(mod: unknown, exportName: string): NativeDatabaseConstructor {
  if (isNativeDatabaseConstructor(mod)) return mod
  if (isRecord(mod)) {
    const named = mod[exportName]
    if (isNativeDatabaseConstructor(named)) return named
    const fallback = mod.default
    if (isNativeDatabaseConstructor(fallback)) return fallback
  }
  throw new Error(`sqlite driver export ${exportName} missing`)
}

function finalized<T>(statement: NativeStatement<unknown>, read: () => T): T {
  try {
    return read()
  } finally {
    statement.finalize?.()
  }
}

/**
 * A `SqliteDatabase` over the native driver of the running engine: `bun:sqlite`
 * under Bun, better-sqlite3 under Node. `load` is the host's own `require`, so
 * the driver resolves from the package that depends on it.
 */
export function openNativeSqliteDatabase(load: (specifier: string) => unknown, file: string): SqliteDatabase {
  const driver = "Bun" in globalThis
    ? nativeConstructor(load("bun:sqlite"), "Database")
    : nativeConstructor(load("better-sqlite3"), "default")
  const db = new driver(file)
  return {
    exec: (sql) => {
      db.exec(sql)
    },
    prepare<Row>(sql: string) {
      const statement = db.prepare<Row>(sql)
      return {
        run: (...params) => finalized(statement, () => ({ changes: statement.run(...params).changes })),
        get: (...params) => finalized(statement, () => statement.get(...params)),
        all: (...params) => finalized(statement, () => statement.all(...params)),
      }
    },
    transaction<T>(run: () => T): T {
      let result!: T
      db.transaction(() => {
        result = run()
      }).immediate()
      return result
    },
    // Bun's binding defaults `throwOnError` to false, which silently leaves a
    // handle SQLite refused to close open and keeps the directory locked on
    // Windows.
    close: () => {
      db.close(true)
    },
  }
}
