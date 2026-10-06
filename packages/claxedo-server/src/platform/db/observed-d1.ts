import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"

/** Runs around every execution the database performs: one statement, or a batch of them, with their SQL. */
export type D1Observer = <T>(statements: readonly string[], run: () => Promise<T>) => Promise<T>

const EXECUTIONS = new Set<string | symbol>(["first", "all", "run", "raw"])

/**
 * The same database, with every execution passed through `observe`. A bound
 * statement keeps its SQL, and a batch reports every statement it carries, so
 * an observer can count or time what the database answers without the callers
 * knowing they are observed.
 */
export function observedD1(database: D1Database, observe: D1Observer): D1Database {
  const texts = new WeakMap<D1PreparedStatement, string>()
  const statement = (prepared: D1PreparedStatement, sql: string): D1PreparedStatement => {
    texts.set(prepared, sql)
    return new Proxy(prepared, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver)
        if (key === "bind") return (...values: unknown[]) => statement(target.bind(...values), sql)
        if (typeof value !== "function") return value
        if (EXECUTIONS.has(key)) return (...args: unknown[]) => observe([sql], () => Promise.resolve(Reflect.apply(value, target, args)))
        return value.bind(target)
      },
    })
  }
  return new Proxy(database, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver)
      if (key === "prepare") return (sql: string) => statement(target.prepare(sql), sql)
      if (key === "batch") return (prepared: D1PreparedStatement[]) => observe(prepared.map((item) => texts.get(item) ?? "?"), () => target.batch(prepared))
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
