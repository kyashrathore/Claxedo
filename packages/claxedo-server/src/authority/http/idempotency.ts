/**
 * Control-plane idempotency for register/checkpoint/repair.
 *
 * ## Two layers, one guarantee (W4.2)
 *
 * 1. A per-isolate `Map` — the FAST path. A retry that lands on the same isolate
 *    (the common case) is answered without a durable round trip, and concurrent
 *    in-isolate requests share one in-flight promise.
 * 2. An optional `DurableIdempotencyStore` — the SOURCE OF TRUTH. Which storage
 *    backs it is the composition's choice; this module never names one.
 *
 * Layer 1 alone was the bug. Cloudflare runs many isolates per deployment and
 * gives no control over how many, so two isolates each held an empty map and
 * both executed the same "idempotent" operation; the client's key bought nothing
 * across isolates. It is sharper after the timeout work than before it, because
 * `withTimeout` bounds the caller's wait WITHOUT cancelling the fetch — so a
 * timed-out operation may still be running when the client's retry arrives on a
 * different isolate.
 *
 * A local hit therefore short-circuits (that isolate already owns the
 * operation), and only a local MISS consults the durable layer.
 *
 * ## Two leaks fixed here (found 2026-07-30 during the W4 review)
 *
 * - In-flight `pullResults` entries had no `expiresAt`, so they were neither
 *   swept (the sweep skips undefined) nor evictable at capacity (eviction skips
 *   undefined too). One hung `run` held its slot forever; 1,000 of them wedged
 *   the whole cache into permanent 503s with no recovery short of a redeploy.
 *   In-flight entries now carry a deadline as well, and the capacity path
 *   evicts on it.
 * - `pullLocks` deleted its entry in a `finally` that only runs when `next`
 *   settles. A `run` that never settles left the lock in the map forever AND
 *   left every later request for that key chained behind a promise that will
 *   never resolve. The chain is now built on a deadline-bounded link, so a
 *   wedged predecessor stops blocking its successors.
 *
 * Both are the same failure shape: an unbounded wait recorded as if it were a
 * bounded one.
 */

/** Guard against a hung `run` holding a serialization slot or cache entry forever. */
const IDEMPOTENCY_INFLIGHT_TTL_MS = 60_000
const IDEMPOTENCY_TTL_MS = 5 * 60_000
const IDEMPOTENCY_MAX_ENTRIES = 1_000
export const IDEMPOTENCY_KEY_MAX_LENGTH = 256
export { IDEMPOTENCY_INFLIGHT_TTL_MS, IDEMPOTENCY_TTL_MS }

const pullLocks = new Map<string, Promise<unknown>>()
const pullResults = new Map<string, {
  expiresAt: number
  /** True while `run` is outstanding: the entry is a coalescing slot, not a result. */
  pending: boolean
  fingerprint: string
  promise: Promise<unknown>
}>()

/**
 * The durable half. A store is optional everywhere: `server.ts` (self-host,
 * one process) and tests run without one, where the per-isolate map IS the
 * whole isolate population and is therefore already correct for that topology.
 */
export type DurableIdempotencyStore = {
  begin: (input: { cacheKey: string; fingerprint: string }) => Promise<
    | { state: "acquired" }
    | { state: "in_flight" }
    | { state: "completed"; resultJson?: string }
    | { state: "conflict" }
  >
  complete: (input: { cacheKey: string; fingerprint: string; resultJson?: string }) => Promise<unknown>
  release: (input: { cacheKey: string; fingerprint: string }) => Promise<unknown>
}

let durableStore: DurableIdempotencyStore | undefined

/**
 * Install the durable layer. Called once at composition (hosted only); absent
 * on self-host and in unit tests. Returns a restore function so a test can
 * install a fake without leaking it into the next test.
 */
export function setDurableIdempotencyStore(store: DurableIdempotencyStore | undefined) {
  const previous = durableStore
  durableStore = store
  return () => {
    durableStore = previous
  }
}

/**
 * The installed store, for callers that dedup something other than a session
 * operation — e.g. a provider webhook, which needs the same durable table but
 * keys on a delivery id rather than a client idempotency key. Such callers own
 * their own key prefix so a delivery id can never collide with a session
 * operation's cache key.
 */
export function durableIdempotencyStore() {
  return durableStore
}

export class IdempotencyCapacityError extends Error {
  readonly status = 503
  readonly code = "control_plane_idempotency_capacity_exceeded"

  constructor() {
    super("Control-plane idempotency capacity is temporarily exhausted")
  }
}

export class IdempotencyConflictError extends Error {
  readonly status = 409
  readonly code = "control_plane_idempotency_payload_mismatch"

  constructor() {
    super("Idempotency key was already used with a different request payload")
  }
}

/**
 * Another isolate holds this key and is still running it. 409, not a wait: the
 * request cannot be served without either re-executing (which is the thing
 * being prevented) or blocking on work in an isolate this one cannot observe.
 * The client retries, exactly as it would on the conflict above.
 */
export class IdempotencyInFlightError extends Error {
  readonly status = 409
  readonly code = "control_plane_idempotency_in_flight"

  constructor() {
    super("Idempotency key is already being processed")
  }
}

class InvalidIdempotencyKeyError extends Error {
  readonly status = 400
  readonly code = "invalid_control_plane_payload"

  constructor() {
    super(`idempotencyKey must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`)
  }
}

export function lockKey(workspaceId: string, sessionId: string) {
  return `${workspaceId}\0${sessionId}`
}

/**
 * Serialize by key within this isolate.
 *
 * The chain link each waiter is given is bounded: if a predecessor's `run`
 * never settles, its successors proceed after the in-flight deadline rather
 * than waiting forever behind it. Serialization is a contention guard, not a
 * correctness barrier (the durable layer above is that), so degrading to
 * "proceed after the deadline" is the right failure — the alternative is a
 * permanently stuck session key.
 */
export async function serialized<T>(key: string, run: () => Promise<T>) {
  const previous = pullLocks.get(key)
  const ready = previous
    ? Promise.race([
      previous.catch(() => undefined),
      new Promise<void>((resolve) => {
        const timer: unknown = setTimeout(resolve, IDEMPOTENCY_INFLIGHT_TTL_MS)
        // Never hold the Node event loop open on a lock-release timer. Absent on
        // workerd, where timers do not keep an isolate alive.
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
    : Promise.resolve()
  const next = ready.then(run)
  pullLocks.set(key, next)
  try {
    return await next
  } finally {
    if (pullLocks.get(key) === next) pullLocks.delete(key)
  }
}

export function parseIdempotencyKey(input: unknown) {
  if (typeof input !== "string") return
  if (input.length > IDEMPOTENCY_KEY_MAX_LENGTH) throw new InvalidIdempotencyKeyError()
  const key = input.trim()
  if (!key) return
  return key
}

export function idempotencyCacheKey(input: {
  operation: string
  principal: string
  workspaceId: string
  sessionId: string
  key?: string
}) {
  if (!input.key) return
  return JSON.stringify([
    input.operation,
    input.principal,
    input.workspaceId,
    input.sessionId,
    input.key,
  ])
}

export function idempotencyFingerprint(input: {
  reason?: string
  expectedEventOrdinal?: number
}) {
  return JSON.stringify([
    input.reason ?? null,
    input.expectedEventOrdinal ?? null,
  ])
}

/** Retire entries whose deadline has passed — in-flight ones included. */
function sweep(now: number) {
  for (const [candidate, entry] of pullResults) {
    if (entry.expiresAt <= now) pullResults.delete(candidate)
  }
}

/**
 * Make room at capacity by dropping SETTLED results, soonest-expiring first.
 *
 * A live pending entry is deliberately not evicted: a caller is awaiting its
 * promise, and dropping the slot would let a concurrent duplicate execute
 * against the same session. New distinct work is refused with a 503 instead —
 * shedding load is the correct answer at capacity, and it is what the existing
 * `rejects new distinct work at pending capacity` test pins.
 *
 * The leak was never that pending entries are unevictable; it was that they were
 * un-EXPIRABLE. With no `expiresAt` the sweep skipped them, so a hung `run` held
 * its slot until the isolate died. Now the sweep collects them once their
 * deadline passes, and capacity recovers on its own.
 */
function evictForCapacity() {
  if (pullResults.size < IDEMPOTENCY_MAX_ENTRIES) return
  const settled = [...pullResults]
    .filter(([, entry]) => !entry.pending)
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
  for (const [candidate] of settled) {
    if (pullResults.size < IDEMPOTENCY_MAX_ENTRIES) return
    pullResults.delete(candidate)
  }
}

export function cachedIdempotency<T>(
  key: string | undefined,
  run: () => Promise<T>,
  fingerprint = "",
) {
  if (!key) return run()
  sweep(Date.now())
  const hit = pullResults.get(key)
  if (hit) {
    if (hit.fingerprint !== fingerprint) return Promise.reject(new IdempotencyConflictError())
    return hit.promise as Promise<T>
  }
  evictForCapacity()
  if (pullResults.size >= IDEMPOTENCY_MAX_ENTRIES) {
    return Promise.reject(new IdempotencyCapacityError())
  }
  // A local miss is the only case that consults the durable layer: a local hit
  // means THIS isolate already owns the operation, so the round trip would tell
  // it what it already knows.
  const guarded = durableStore
    ? durableIdempotency(durableStore, { cacheKey: key, fingerprint, run })
    : run
  const promise = Promise.resolve().then(guarded).then((value) => {
    const entry = pullResults.get(key)
    if (entry?.promise === promise) {
      entry.pending = false
      entry.expiresAt = Date.now() + IDEMPOTENCY_TTL_MS
    }
    return value
  }, (error) => {
    // A failure is not a result: caching it would replay one transient error
    // for the whole TTL.
    if (pullResults.get(key)?.promise === promise) pullResults.delete(key)
    throw error
  })
  pullResults.set(key, {
    fingerprint,
    promise,
    pending: true,
    // In-flight entries carry a deadline too. Without one they were neither
    // swept nor evicted, and a hung `run` held its slot until the isolate died.
    expiresAt: Date.now() + IDEMPOTENCY_INFLIGHT_TTL_MS,
  })
  return promise
}

/**
 * Wrap `run` in a durable claim so only one isolate executes it.
 *
 * A store failure is NOT swallowed. The point of this layer is that the
 * operation runs once; degrading to "run it anyway" on a store hiccup would
 * quietly restore the bug precisely when the store is unhealthy — which is when
 * client retries, and therefore duplicate deliveries, are most likely.
 */
function durableIdempotency<T>(
  store: DurableIdempotencyStore,
  input: { cacheKey: string; fingerprint: string; run: () => Promise<T> },
) {
  return async () => {
    const claim = await store.begin({ cacheKey: input.cacheKey, fingerprint: input.fingerprint })
    if (claim.state === "conflict") throw new IdempotencyConflictError()
    if (claim.state === "in_flight") throw new IdempotencyInFlightError()
    if (claim.state === "completed") {
      // Replay the recorded response. A completed row with no body means the
      // operation returned nothing worth recording, not that it never ran.
      return (claim.resultJson === undefined ? undefined : JSON.parse(claim.resultJson)) as T
    }
    let value: T
    try {
      value = await input.run()
    } catch (error) {
      // Release the claim so the client's retry can execute rather than
      // waiting out the lease.
      await store.release({ cacheKey: input.cacheKey, fingerprint: input.fingerprint }).catch(() => {})
      throw error
    }
    await store.complete({
      cacheKey: input.cacheKey,
      fingerprint: input.fingerprint,
      ...(value === undefined ? {} : { resultJson: JSON.stringify(value) }),
    })
    return value
  }
}
