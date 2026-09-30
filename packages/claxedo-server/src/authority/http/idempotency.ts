import type { D1Database } from "@cloudflare/workers-types"
import { parseJson } from "@claxedo/server-core/platform/json/index"

const IDEMPOTENCY_INFLIGHT_TTL_MS = 60_000
const IDEMPOTENCY_TTL_MS = 5 * 60_000
const IDEMPOTENCY_MAX_ENTRIES = 1_000
export const IDEMPOTENCY_KEY_MAX_LENGTH = 256
export { IDEMPOTENCY_INFLIGHT_TTL_MS, IDEMPOTENCY_TTL_MS }
const D1_PRUNE_BATCH = 100
/** Every D1 deadline is dated and compared by the database's clock, never an isolate's. */
const D1_NOW_MS = "cast(unixepoch('subsec') * 1000 as integer)"

export type IdempotencyClaim =
  | { state: "acquired" }
  | { state: "in_flight" }
  | { state: "completed"; resultJson?: string }
  | { state: "conflict" }

/**
 * One row per cache key, shared by every instance that serves the key. A row
 * whose deadline has passed no longer exists: `begin` claims over it, which is
 * how an in-flight claim abandoned by a dead instance is taken over after its
 * lease. Only the holder of `claimId` may complete or release a claim. A lease
 * or replay window arrives as a duration and the store dates it by its own
 * clock, so instances whose clocks disagree still agree on when a row lapses.
 */
export type DurableIdempotencyStore = {
  begin(input: { cacheKey: string; fingerprint: string; claimId: string; leaseMs: number }): Promise<IdempotencyClaim>
  complete(input: { cacheKey: string; claimId: string; resultJson?: string; replayMs: number }): Promise<unknown>
  release(input: { cacheKey: string; claimId: string }): Promise<unknown>
}

/**
 * The result is `unknown` because a replay is the recorded JSON, not what `run`
 * returned: a caller typed `T` would be told a `Date` came back where a string
 * did. Every caller serializes it straight into its response.
 */
export type IdempotencyCoordinator = {
  run(key: string | undefined, run: () => Promise<unknown>, fingerprint?: string): Promise<unknown>
}

export function createIdempotencyCoordinator(store: DurableIdempotencyStore): IdempotencyCoordinator {
  const pending = new Map<string, { fingerprint: string; promise: Promise<unknown>; expiresAt: number }>()
  return {
    run(key, run, fingerprint = "") {
      if (!key) return run()
      const now = Date.now()
      pruneLapsed(pending, now)
      const hit = pending.get(key)
      if (hit) {
        if (hit.fingerprint !== fingerprint) return Promise.reject(new IdempotencyConflictError())
        return hit.promise
      }
      if (pending.size >= IDEMPOTENCY_MAX_ENTRIES) return Promise.reject(new IdempotencyCapacityError())
      const promise = runClaimed(store, key, fingerprint, run).finally(() => {
        if (pending.get(key)?.promise === promise) pending.delete(key)
      })
      pending.set(key, { fingerprint, promise, expiresAt: now + IDEMPOTENCY_INFLIGHT_TTL_MS })
      return promise
    },
  }
}

/**
 * A store failure propagates. Running the command anyway would restore
 * duplicate execution exactly when the store is unhealthy, which is when
 * clients retry most.
 */
async function runClaimed(store: DurableIdempotencyStore, cacheKey: string, fingerprint: string, run: () => Promise<unknown>) {
  const claimId = crypto.randomUUID()
  const claim = await store.begin({ cacheKey, fingerprint, claimId, leaseMs: IDEMPOTENCY_INFLIGHT_TTL_MS })
  if (claim.state === "conflict") throw new IdempotencyConflictError()
  if (claim.state === "in_flight") throw new IdempotencyInFlightError()
  if (claim.state === "completed") return claim.resultJson === undefined ? undefined : parseJson(claim.resultJson)
  let value: unknown
  try {
    value = await run()
  } catch (error) {
    // A failure is not a result: the retry runs instead of waiting out the lease.
    await store.release({ cacheKey, claimId }).catch(() => {})
    throw error
  }
  await store.complete({
    cacheKey,
    claimId,
    ...(value === undefined ? {} : { resultJson: JSON.stringify(value) }),
    replayMs: IDEMPOTENCY_TTL_MS,
  })
  return value
}

/**
 * Deletes a map's lapsed entries from its oldest end and stops at the first
 * live one. Entries inserted in deadline order hold every lapsed entry at that
 * end, so a call visits only what it deletes.
 */
function pruneLapsed(entries: Map<string, { expiresAt: number }>, now: number) {
  for (const [key, entry] of entries) {
    if (entry.expiresAt > now) return
    entries.delete(key)
  }
}

/** An entry out of deadline order can outlive a prune, so a lookup checks its own deadline. */
function liveEntry<T extends { expiresAt: number }>(entries: Map<string, T>, key: string, now: number) {
  const entry = entries.get(key)
  if (!entry || entry.expiresAt > now) return entry
  entries.delete(key)
  return undefined
}

/**
 * The store for a composition whose one process is every instance that serves
 * a key. Claims and receipts live in separate maps because each is inserted
 * in the deadline order of its own window. Together they hold at most
 * `IDEMPOTENCY_MAX_ENTRIES` keys: past that a new key is refused, while a key
 * already held still reports its claim or replays its receipt.
 */
export function memoryIdempotencyStore(): DurableIdempotencyStore {
  const claims = new Map<string, { fingerprint: string; claimId: string; expiresAt: number }>()
  const receipts = new Map<string, { fingerprint: string; resultJson?: string; expiresAt: number }>()
  return {
    async begin({ cacheKey, fingerprint, claimId, leaseMs }) {
      const now = Date.now()
      pruneLapsed(claims, now)
      pruneLapsed(receipts, now)
      const held = liveEntry(claims, cacheKey, now)
      const receipt = liveEntry(receipts, cacheKey, now)
      const row = held ?? receipt
      if (!row) {
        if (claims.size + receipts.size >= IDEMPOTENCY_MAX_ENTRIES) throw new IdempotencyCapacityError()
        claims.set(cacheKey, { fingerprint, claimId, expiresAt: now + leaseMs })
        return { state: "acquired" }
      }
      if (row.fingerprint !== fingerprint) return { state: "conflict" }
      if (held) return { state: "in_flight" }
      return { state: "completed", ...(receipt?.resultJson === undefined ? {} : { resultJson: receipt.resultJson }) }
    },
    async complete({ cacheKey, claimId, resultJson, replayMs }) {
      const held = claims.get(cacheKey)
      if (held?.claimId !== claimId) return
      claims.delete(cacheKey)
      receipts.set(cacheKey, { fingerprint: held.fingerprint, ...(resultJson === undefined ? {} : { resultJson }), expiresAt: Date.now() + replayMs })
    },
    async release({ cacheKey, claimId }) {
      if (claims.get(cacheKey)?.claimId === claimId) claims.delete(cacheKey)
    },
  }
}

/**
 * Taking over a claim whose lease passed may run a command twice: the first
 * run may have committed, or still be running, when its successor starts.
 * Register, checkpoint and repair tolerate that because each re-pulls the
 * runtime's current snapshot and each of its writes refuses an older one: the
 * projection and the authority keep a message snapshot only at or above their
 * stored event ordinal, and a session's title and archive state only at or
 * above their stored runtime `time.updated`. A message snapshot the runtime
 * sends without an event ordinal has no such fence.
 */
export function d1ProjectionCommandIdempotency(database: D1Database): DurableIdempotencyStore {
  return {
    async begin({ cacheKey, fingerprint, claimId, leaseMs }) {
      const [, , current] = await database.batch<{ fingerprint: string; state: "in_flight" | "completed"; claim_id: string; result_json: string | null }>([
        database.prepare(`
          delete from projection_command_idempotency where rowid in (
            select rowid from projection_command_idempotency where expires_at <= ${D1_NOW_MS} and cache_key <> ? limit ${D1_PRUNE_BATCH}
          )
        `).bind(cacheKey),
        database.prepare(`
          insert into projection_command_idempotency (cache_key, fingerprint, state, claim_id, result_json, expires_at)
          values (?, ?, 'in_flight', ?, null, ${D1_NOW_MS} + ?)
          on conflict (cache_key) do update set
            fingerprint = excluded.fingerprint,
            state = excluded.state,
            claim_id = excluded.claim_id,
            result_json = null,
            expires_at = excluded.expires_at
          where projection_command_idempotency.expires_at <= ${D1_NOW_MS}
        `).bind(cacheKey, fingerprint, claimId, leaseMs),
        database.prepare(`
          select fingerprint, state, claim_id, result_json from projection_command_idempotency where cache_key = ?
        `).bind(cacheKey),
      ])
      const row = current.results[0]
      if (row.claim_id === claimId) return { state: "acquired" }
      if (row.fingerprint !== fingerprint) return { state: "conflict" }
      if (row.state === "in_flight") return { state: "in_flight" }
      return { state: "completed", ...(row.result_json === null ? {} : { resultJson: row.result_json }) }
    },
    async complete({ cacheKey, claimId, resultJson, replayMs }) {
      await database.prepare(`
        update projection_command_idempotency set state = 'completed', result_json = ?, expires_at = ${D1_NOW_MS} + ?
        where cache_key = ? and claim_id = ? and state = 'in_flight'
      `).bind(resultJson ?? null, replayMs, cacheKey, claimId).run()
    },
    async release({ cacheKey, claimId }) {
      await database.prepare(`
        delete from projection_command_idempotency where cache_key = ? and claim_id = ? and state = 'in_flight'
      `).bind(cacheKey, claimId).run()
    },
  }
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
 * Another instance holds this key and is still running it. 409, not a wait: the
 * request cannot be served without either re-executing (which is the thing
 * being prevented) or blocking on work in an instance this one cannot observe.
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

const sessionLocks = new Map<string, Promise<unknown>>()

export function lockKey(workspaceId: string, sessionId: string) {
  return `${workspaceId}\0${sessionId}`
}

/**
 * Runs one projection command per session at a time within this process. It
 * guards contention, not correctness (the projection writes are ordinal-guarded
 * and other instances are not serialized), so a predecessor that never settles
 * stops blocking its successors after the in-flight deadline instead of leaving
 * the session stuck.
 */
export async function serialized<T>(key: string, run: () => Promise<T>) {
  const previous = sessionLocks.get(key)
  const ready = previous
    ? Promise.race([
      previous.catch(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, IDEMPOTENCY_INFLIGHT_TTL_MS)
        // Never hold the Node event loop open on a lock-release timer. Absent on
        // workerd, where a timer handle is a number and does not keep an isolate alive.
        if (typeof timer === "object") timer.unref()
      }),
    ])
    : Promise.resolve()
  const next = ready.then(run)
  sessionLocks.set(key, next)
  try {
    return await next
  } finally {
    if (sessionLocks.get(key) === next) sessionLocks.delete(key)
  }
}

export function parseIdempotencyKey(input: unknown) {
  if (typeof input !== "string") return undefined
  if (input.length > IDEMPOTENCY_KEY_MAX_LENGTH) throw new InvalidIdempotencyKeyError()
  const key = input.trim()
  if (!key) return undefined
  return key
}

export function idempotencyCacheKey(input: {
  operation: string
  principal: string
  workspaceId: string
  sessionId: string
  key?: string
}) {
  if (!input.key) return undefined
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
