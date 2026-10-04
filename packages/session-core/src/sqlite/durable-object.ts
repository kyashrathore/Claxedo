import type { SqliteDatabase, SqliteStatement } from "./database"

export type DurableObjectSqlStorage = {
  sql: {
    exec<Row>(query: string, ...bindings: unknown[]): { toArray(): Row[] }
  }
  transactionSync<T>(run: () => T): T
}

/**
 * A `SqliteDatabase` over a Durable Object's embedded SQLite.
 *
 * `changes()` is read back rather than taken from the cursor's `rowsWritten`,
 * which also counts the index rows a write touched.
 */
export function durableObjectSqliteDatabase(storage: DurableObjectSqlStorage): SqliteDatabase {
  const rows = <Row>(sql: string, params: unknown[]) => storage.sql.exec<Row>(sql, ...params).toArray()
  return {
    exec: (sql) => {
      rows(sql, [])
    },
    prepare<Row>(sql: string): SqliteStatement<Row> {
      return {
        run: (...params) => {
          rows(sql, params)
          const [written] = rows<{ changes: number }>("SELECT changes() AS changes", [])
          return { changes: written?.changes ?? 0 }
        },
        get: (...params) => rows<Row>(sql, params)[0],
        all: (...params) => rows<Row>(sql, params),
      }
    },
    transaction: (run) => storage.transactionSync(run),
    close: () => {},
  }
}
