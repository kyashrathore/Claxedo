import { AsyncLocalStorage } from "node:async_hooks"
import type { D1Database } from "@cloudflare/workers-types"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import { withSecurityHeaders } from "@claxedo/server-core/platform/http/security-headers"
import { observedD1 } from "../db/observed-d1"

/**
 * Where a request's time went besides its own code: verifying the caller
 * (`auth`, which includes the database reads that verification makes), the
 * shared rate-limit binding, the databases, and the Durable Objects it called.
 */
export type TimedResource = "auth" | "limit" | "d1" | "do"

const RESOURCES: readonly TimedResource[] = ["auth", "limit", "d1", "do"]

/**
 * A fact about the request rather than a duration: `cold` on the first request
 * an isolate serves, `compose` on a request that built the control plane
 * instead of reusing one.
 */
export type TimingMark = "cold" | "compose"

/** Busy time per resource: concurrent calls share their overlap, so no resource can read more than the total. */
type Busy = { ms: number; active: number; since: number }
type Ledger = { busy: Record<TimedResource, Busy>; marks: Set<TimingMark> }

/** A request slower than this is written to the Worker's log with its breakdown, so `wrangler tail` shows where it went. */
export const SLOW_REQUEST_MS = 1_000

const requests = new AsyncLocalStorage<Ledger>()
let served = 0

/** Adds the time `run` keeps `resource` busy to the current request's ledger; outside a request it only runs. */
export async function timed<T>(resource: TimedResource, run: () => Promise<T>): Promise<T> {
  const ledger = requests.getStore()
  if (!ledger) return run()
  const busy = ledger.busy[resource]
  if (busy.active++ === 0) busy.since = performance.now()
  try {
    return await run()
  } finally {
    if (--busy.active === 0) busy.ms += performance.now() - busy.since
  }
}

/** Records `fact` on the current request; outside a request it records nothing. */
export function mark(fact: TimingMark) {
  requests.getStore()?.marks.add(fact)
}

/** The database with every statement's wall time charged to the request that ran it. */
export function timedD1(database: D1Database): D1Database {
  return observedD1(database, (_statements, run) => timed("d1", run))
}

/** The adapter with every verification's wall time charged to the request that asked. */
export function timedAuthentication<Adapter extends RequestAuthenticationAdapter>(adapter: Adapter): Adapter {
  return { ...adapter, authenticate: (request: Request) => timed("auth", () => adapter.authenticate(request)) }
}

function header(ledger: Ledger, total: number): string {
  return [
    ...ledger.marks,
    ...RESOURCES.map((resource) => `${resource};dur=${ledger.busy[resource].ms.toFixed(1)}`),
    `total;dur=${total.toFixed(1)}`,
  ].join(", ")
}

/**
 * Answers a request through `respond` with a `Server-Timing` header naming
 * where its time went, so a client, the browser's resource timing and the
 * deployment's logs all measure the same thing.
 *
 * On the Workers runtime `performance.now()` advances only across I/O
 * (developers.cloudflare.com/workers/runtime-apis/performance/), so every
 * duration here is time spent waiting on something and CPU-bound work reads as
 * zero; the marks say when a request also paid an isolate start or a
 * control-plane composition.
 */
export async function timedResponse(request: Request, respond: () => Promise<Response>): Promise<Response> {
  const idle = (): Busy => ({ ms: 0, active: 0, since: 0 })
  const ledger: Ledger = {
    busy: { auth: idle(), limit: idle(), d1: idle(), do: idle() },
    marks: new Set(served++ === 0 ? ["cold"] : []),
  }
  const started = performance.now()
  const response = await requests.run(ledger, respond)
  const total = performance.now() - started
  const timing = header(ledger, total)
  if (total >= SLOW_REQUEST_MS) console.log(`[timing] ${request.method} ${new URL(request.url).pathname} ${response.status} ${timing}`)
  return withSecurityHeaders(response, [["server-timing", timing]])
}
