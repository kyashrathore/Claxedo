import type { D1Database } from "@cloudflare/workers-types"
import { observedD1 } from "../platform/db/observed-d1"

export type D1Rounds = {
  readonly database: D1Database
  /** Statements that began while none was in flight: the serial round trips a caller waited on, one per cross-region hop in production. */
  rounds(): number
  statements(): number
  /** The statements in order, each with the round it ran in, for reading a chain the count alone does not explain. */
  trace(): readonly { round: number; sql: string }[]
  reset(): void
}

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
  const counted = observedD1(database, async (sql, run) => {
    if (inFlight === 0) rounds += 1
    statements += sql.length
    trace.push(...sql.map((text) => ({ round: rounds, sql: text.replace(/\s+/g, " ").trim().slice(0, 90) })))
    inFlight += 1
    try {
      return await run()
    } finally {
      inFlight -= 1
    }
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
