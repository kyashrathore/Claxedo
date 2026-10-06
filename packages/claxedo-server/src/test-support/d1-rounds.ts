import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"

export type D1Rounds = {
  readonly database: D1Database
  /** Statements that began while none was in flight: the serial round trips a caller waited on, one per cross-region hop in production. */
  rounds(): number
  statements(): number
  /** The statements in order, each with the round it ran in, for reading a chain the count alone does not explain. */
  trace(): readonly { round: number; sql: string }[]
  reset(): void
}

const EXECUTIONS = new Set<string | symbol>(["first", "all", "run", "raw"])

/**
 * Counts the statements a database answers and how many of them ran alone.
 * A `batch` is one round however many statements it carries, and statements
 * started together (`Promise.all`) count as one round, so the number is the
 * depth of the serial chain a request pays rather than its total work.
 */
export function countD1Rounds(database: D1Database): D1Rounds {
  let inFlight = 0
  let rounds = 0
  let statements = 0
  let trace: { round: number; sql: string }[] = []
  const track = async <T>(sql: string[], run: () => Promise<T>) => {
    if (inFlight === 0) rounds += 1
    statements += sql.length
    trace.push(...sql.map((text) => ({ round: rounds, sql: text.replace(/\s+/g, " ").trim().slice(0, 90) })))
    inFlight += 1
    try {
      return await run()
    } finally {
      inFlight -= 1
    }
  }
  const texts = new WeakMap<D1PreparedStatement, string>()
  const statement = (prepared: D1PreparedStatement, sql: string): D1PreparedStatement => {
    texts.set(prepared, sql)
    return new Proxy(prepared, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver)
        if (key === "bind") return (...values: unknown[]) => statement(target.bind(...values), sql)
        if (EXECUTIONS.has(key)) return (...args: unknown[]) => track([sql], () => (value as (...input: unknown[]) => Promise<unknown>).apply(target, args))
        return typeof value === "function" ? value.bind(target) : value
      },
    })
  }
  const counted = new Proxy(database, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver)
      if (key === "prepare") return (sql: string) => statement(target.prepare(sql), sql)
      if (key === "batch") return (prepared: D1PreparedStatement[]) => track(prepared.map((item) => texts.get(item) ?? "?"), () => target.batch(prepared))
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return {
    database: counted,
    rounds: () => rounds,
    statements: () => statements,
    trace: () => trace,
    reset: () => {
      rounds = 0
      statements = 0
      trace = []
    },
  }
}
