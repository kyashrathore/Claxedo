import type Database from "better-sqlite3"

type Stmt = {
  get: (...params: any[]) => any
  all: (...params: any[]) => any[]
  run: (...params: any[]) => any
}

type Compat = {
  run: (sql: string, params?: any[]) => any
  query: (sql: string) => Stmt
  exec: (sql: string) => any
  transaction?: (fn: (...args: any[]) => any) => (...args: any[]) => any
  close?: () => void
  filename?: string
  raw?: () => Database | null
}

export type SqliteInput = Database | Compat

export type SqliteDb = {
  run: (sql: string, params?: any[]) => any
  query: (sql: string) => Stmt
  exec: (sql: string) => any
  close: () => void
  filename: string
  raw: () => Database | null
}

type Client = {
  prepare: (sql: string) => {
    run: (...params: any[]) => any
    get: (...params: any[]) => any
    all: (...params: any[]) => any[]
    raw: () => {
      get: (...params: any[]) => any
      all: (...params: any[]) => any[]
    }
  }
  transaction: (fn: (...args: any[]) => any) => (...args: any[]) => any
  exec: (sql: string) => any
  close: () => void
  name: string
}

export function sqlite(input: SqliteInput): SqliteDb {
  if ("query" in input && "run" in input && "raw" in input) return input as SqliteDb
  if ("query" in input && "run" in input) {
    return {
      run: input.run.bind(input),
      query: input.query.bind(input),
      exec: input.exec.bind(input),
      close: input.close?.bind(input) ?? (() => {}),
      filename: input.filename ?? "",
      raw: input.raw?.bind(input) ?? (() => null),
    }
  }

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

export function client(input: SqliteInput): Client {
  if (!("query" in input && "run" in input)) return input as unknown as Client
  const native = input.raw?.()
  if (native) return native as unknown as Client

  return {
    prepare(sql: string) {
      const stmt = input.query(sql) as Stmt & { values?: (...params: any[]) => any[][] }
      return {
        run: (...params: any[]) => input.run(sql, params),
        get: (...params: any[]) => stmt.get(...params),
        all: (...params: any[]) => stmt.all(...params),
        raw() {
          return {
            get: (...params: any[]) => stmt.values?.(...params)?.[0],
            all: (...params: any[]) => stmt.values?.(...params) ?? [],
          }
        },
      }
    },
    transaction(fn: (...args: any[]) => any) {
      return typeof input.transaction === "function" ? input.transaction(fn) : fn
    },
    exec: input.exec.bind(input),
    close: input.close?.bind(input) ?? (() => {}),
    name: input.filename ?? "",
  }
}
