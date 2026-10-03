import type { Storage } from "@earendil-works/pi-durable"
import { SqliteStorage, type SqliteDatabase, type SqliteExecutor, type SqliteValue } from "@earendil-works/pi-durable/storage/sqlite"

type BunStatement = { run(...params: SqliteValue[]): unknown; get(...params: SqliteValue[]): unknown; all(...params: SqliteValue[]): unknown[] }
type BunDatabase = { exec(sql: string): void; prepare(sql: string): BunStatement; close(): void }

function executor(db: BunDatabase, run: <T>(operation: () => T) => Promise<T>): SqliteExecutor {
  return {
    exec: (sql) => run(() => { db.exec(sql) }),
    run: (sql, ...params) => run(() => { db.prepare(sql).run(...params) }),
    get: <T extends object>(sql: string, ...params: SqliteValue[]) => run(() => (db.prepare(sql).get(...params) ?? undefined) as T | undefined),
    all: <T extends object>(sql: string, ...params: SqliteValue[]) => run(() => db.prepare(sql).all(...params) as T[]),
  }
}

function bunPiDatabase(db: BunDatabase): SqliteDatabase {
  let tail: Promise<unknown> = Promise.resolve()
  const queued = <T>(operation: () => T | Promise<T>): Promise<T> => {
    const next = tail.then(operation)
    tail = next.then(() => undefined, () => undefined)
    return next
  }
  return {
    ...executor(db, (operation) => queued(operation)),
    transaction: (callback) => queued(async () => {
      db.exec("BEGIN IMMEDIATE")
      const scope = { active: true }
      try {
        const result = await callback(executor(db, async (operation) => {
          if (!scope.active) throw new Error("SQLite transaction handle is no longer active")
          return operation()
        }))
        scope.active = false
        db.exec("COMMIT")
        return result
      } catch (error) {
        scope.active = false
        db.exec("ROLLBACK")
        throw error
      }
    }),
    close: () => queued(() => {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
      db.close()
    }),
  }
}

export async function openPiStorage(file: string): Promise<Storage> {
  if (!("Bun" in globalThis)) return (await import("@earendil-works/pi-durable/storage/sqlite/node")).openNodeSqliteStorage(file)
  const { Database } = await import("bun:sqlite")
  const db = new Database(file, { create: true })
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA synchronous = NORMAL")
  return SqliteStorage.open(bunPiDatabase(db as unknown as BunDatabase))
}
