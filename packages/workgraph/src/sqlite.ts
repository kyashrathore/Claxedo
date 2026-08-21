import BetterSqlite3 from "better-sqlite3"

export type RawDatabase = InstanceType<typeof BetterSqlite3>

type Stmt = {
  get: (...params: any[]) => any
  all: (...params: any[]) => any[]
  run: (...params: any[]) => any
}

export type SqliteDb = {
  run: (sql: string, params?: any[]) => any
  query: (sql: string) => Stmt
  exec: (sql: string) => any
  close: () => void
  filename: string
  raw: () => RawDatabase | null
}

export type SqliteInput = RawDatabase | SqliteDb

/** Wrap a better-sqlite3 handle (or pass an already-wrapped one through). */
export function sqlite(input: SqliteInput): SqliteDb {
  if ("query" in input && "run" in input && "raw" in input) return input as SqliteDb

  return {
    run(sql: string, params?: any[]) {
      if (params && params.length) return input.prepare(sql).run(...params)
      return input.exec(sql)
    },
    query(sql: string) {
      const stmt = input.prepare(sql)
      return {
        get: (...params: any[]) => stmt.get(...params),
        all: (...params: any[]) => stmt.all(...params),
        run: (...params: any[]) => stmt.run(...params),
      }
    },
    exec: input.exec.bind(input),
    close: input.close.bind(input),
    filename: input.name,
    raw: () => input,
  }
}
