import { AsyncLocalStorage } from "node:async_hooks"
import type { D1Database } from "@cloudflare/workers-types"
import type { MiddlewareHandler } from "hono"
import { withSecurityHeaders } from "@claxedo/server-core/platform/http/security-headers"
import { observedD1 } from "../db/observed-d1"

/** Where a request's time went besides its own code: the databases, and the Durable Objects it called. */
export type TimedResource = "d1" | "do"

/** Busy time per resource: concurrent calls share their overlap, so no resource can read more than the total. */
type Busy = { ms: number; active: number; since: number }
type Ledger = Record<TimedResource, Busy>

/** A request slower than this is written to the Worker's log with its breakdown, so `wrangler tail` shows where it went. */
export const SLOW_REQUEST_MS = 1_000

const requests = new AsyncLocalStorage<Ledger>()

/** Adds the time `run` keeps `resource` busy to the current request's ledger; outside a request it only runs. */
export async function timed<T>(resource: TimedResource, run: () => Promise<T>): Promise<T> {
  const ledger = requests.getStore()
  if (!ledger) return run()
  const busy = ledger[resource]
  if (busy.active++ === 0) busy.since = performance.now()
  try {
    return await run()
  } finally {
    if (--busy.active === 0) busy.ms += performance.now() - busy.since
  }
}

/** The database with every statement's wall time charged to the request that ran it. */
export function timedD1(database: D1Database): D1Database {
  return observedD1(database, (_statements, run) => timed("d1", run))
}

function responseTimingHeader(ledger: Ledger, total: number): string {
  return [`d1;dur=${ledger.d1.ms.toFixed(1)}`, `do;dur=${ledger.do.ms.toFixed(1)}`, `total;dur=${total.toFixed(1)}`].join(", ")
}

/**
 * Answers every response with a `Server-Timing` header naming the request's
 * database time, Durable Object time and total, so a client, the browser's
 * resource timing and the deployment's logs all measure the same thing.
 */
export function responseTiming(): MiddlewareHandler {
  return async (c, next) => {
    const ledger: Ledger = { d1: { ms: 0, active: 0, since: 0 }, do: { ms: 0, active: 0, since: 0 } }
    const started = performance.now()
    await requests.run(ledger, () => next())
    const total = performance.now() - started
    c.res = withSecurityHeaders(c.res, [["server-timing", responseTimingHeader(ledger, total)]])
    if (total >= SLOW_REQUEST_MS) console.log(`[timing] ${c.req.method} ${new URL(c.req.url).pathname} ${c.res.status} total=${total.toFixed(0)}ms d1=${ledger.d1.ms.toFixed(0)}ms do=${ledger.do.ms.toFixed(0)}ms`)
  }
}
