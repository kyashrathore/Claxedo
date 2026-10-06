import { AsyncLocalStorage } from "node:async_hooks"
import type { D1Database } from "@cloudflare/workers-types"
import type { MiddlewareHandler } from "hono"
import { observedD1 } from "../db/observed-d1"

/** Where a request's time went besides its own code: the databases, and the Durable Objects it called. */
export type TimedResource = "d1" | "do"

type Ledger = Record<TimedResource, number>

/** A request slower than this is written to the Worker's log with its breakdown, so `wrangler tail` shows where it went. */
export const SLOW_REQUEST_MS = 1_000

const requests = new AsyncLocalStorage<Ledger>()

/** Adds `run`'s wall time to the current request's ledger for `resource`; outside a request it only runs. */
export async function timed<T>(resource: TimedResource, run: () => Promise<T>): Promise<T> {
  const ledger = requests.getStore()
  if (!ledger) return run()
  const started = performance.now()
  try {
    return await run()
  } finally {
    ledger[resource] += performance.now() - started
  }
}

/** The database with every statement's wall time charged to the request that ran it. */
export function timedD1(database: D1Database): D1Database {
  return observedD1(database, (_statements, run) => timed("d1", run))
}

export function responseTimingHeader(ledger: Ledger, total: number): string {
  return [`d1;dur=${ledger.d1.toFixed(1)}`, `do;dur=${ledger.do.toFixed(1)}`, `total;dur=${total.toFixed(1)}`].join(", ")
}

/**
 * Answers every response with a `Server-Timing` header naming the request's
 * database time, Durable Object time and total, so a client, the browser's
 * resource timing and the deployment's logs all measure the same thing.
 */
export function responseTiming(): MiddlewareHandler {
  return async (c, next) => {
    const ledger: Ledger = { d1: 0, do: 0 }
    const started = performance.now()
    await requests.run(ledger, () => next())
    const total = performance.now() - started
    const header = responseTimingHeader(ledger, total)
    // A response handed through from `fetch` carries immutable headers and refuses the set.
    try {
      c.res.headers.set("server-timing", header)
    } catch {
      c.res = new Response(c.res.body, c.res)
      c.res.headers.set("server-timing", header)
    }
    if (total >= SLOW_REQUEST_MS) console.log(`[timing] ${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} total=${total.toFixed(0)}ms d1=${ledger.d1.toFixed(0)}ms do=${ledger.do.toFixed(0)}ms`)
  }
}
