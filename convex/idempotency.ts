/**
 * W4.2/W4.3 — durable, cross-isolate idempotency for control-plane operations.
 *
 * ## The bug this table exists to close
 *
 * `packages/claxedo-server/src/control-plane/http-idempotency.ts` deduplicated
 * register/checkpoint/repair in two per-isolate `Map`s. Cloudflare runs many
 * isolates per deployment and gives no control over how many, so two isolates
 * each held their own empty cache and both executed the "idempotent" operation.
 * The client's idempotency key bought nothing across isolates — the exact
 * guarantee it was there to provide.
 *
 * This is sharper after the timeout fix than before it: `withTimeout` bounds the
 * CALLER's wait and does not cancel the underlying fetch, so a timed-out
 * mutation may still commit. A client retry then lands on a different isolate,
 * misses the cache, and re-runs an operation whose first execution is still in
 * flight.
 *
 * ## Shape: in-flight lease, then completed receipt
 *
 * `begin` is a compare-and-claim, modelled on `orgs.ts`'s deletion barrier
 * (`prepareOrgDeletion`), which is the in-repo template for "one holder, lease
 * with takeover, durable receipt of the result":
 *
 *   - no row               → claim it, `state: "in_flight"`. Caller executes.
 *   - `in_flight`, live    → someone else is running it. Caller must NOT
 *                            execute; it reports in-progress and the client
 *                            retries. This is the cross-isolate property.
 *   - `in_flight`, expired → the holder died mid-operation. Take over. A lease
 *                            that never expired would convert one crashed
 *                            isolate into a permanently un-runnable key.
 *   - `completed`, live    → return the recorded result. No re-execution.
 *   - fingerprint mismatch → `conflict`. Same key, different payload is a
 *                            client bug and must never silently return the
 *                            other payload's result.
 *
 * ## Why the result is stored as an opaque JSON string
 *
 * The control plane replays whatever the route returned. Storing it as `v.any()`
 * would put an unvalidated route response shape into the schema and make every
 * future route change a schema concern; a string keeps the boundary at the
 * adapter, which is the only place that knows the shape.
 *
 * ## Namespacing
 *
 * `cache_key` is opaque and already principal-scoped by the caller
 * (`idempotencyCacheKey` includes operation + principal + workspace + session).
 * The Polar webhook dedup (W4.3) rides the same table under its own key prefix
 * so there is ONE mechanism, one TTL story, and one sweep rather than a second
 * near-copy of this file.
 */
import { v } from "convex/values"
import { cronMutation, serviceMutation } from "./model"

/**
 * How long a claimed-but-unfinished operation holds the key.
 *
 * Sized against the caller's own deadline rather than picked round: a
 * control-plane request is already bounded by the Convex mutation timeout (10s
 * default) plus the runtime pull behind it, so 60s is comfortably longer than
 * any honest in-flight operation. Past that the holder is not slow, it is gone
 * — and the next caller must be able to proceed.
 */
export const IDEMPOTENCY_LEASE_MS = 60_000

/**
 * How long a completed result is replayable. Matches the in-memory layer's
 * `IDEMPOTENCY_TTL_MS` so the fast local cache and the durable one expire
 * together; a local layer that outlived the durable row would answer from
 * cache after the durable record was already collectable.
 */
export const IDEMPOTENCY_RESULT_TTL_MS = 5 * 60_000

/** Rows one sweep tick may retire. Bounds the transaction read set. */
export const IDEMPOTENCY_SWEEP_LIMIT = 500

type BeginResult =
  | { state: "acquired" }
  | { state: "in_flight" }
  | { state: "completed"; result_json?: string }
  | { state: "conflict" }

async function row(ctx: any, cacheKey: string) {
  return ctx.db
    .query("control_idempotency")
    .withIndex("by_cache_key", (q: any) => q.eq("cache_key", cacheKey))
    .unique()
}

export const begin = serviceMutation({
  args: {
    cache_key: v.string(),
    fingerprint: v.string(),
    now: v.number(),
    lease_ms: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<BeginResult> => {
    const leaseMs = args.lease_ms ?? IDEMPOTENCY_LEASE_MS
    const existing = await row(ctx, args.cache_key)
    if (existing) {
      // Payload binding is checked BEFORE expiry: reusing a key with different
      // arguments is a client error whether or not the first execution is stale,
      // and answering it with the other payload's result would be worse than
      // either re-running or refusing.
      if (existing.fingerprint !== args.fingerprint) return { state: "conflict" }
      if (existing.state === "completed") {
        if (existing.expires_at > args.now) {
          return { state: "completed", ...(existing.result_json ? { result_json: existing.result_json } : {}) }
        }
      } else if (existing.lease_expires_at > args.now) {
        return { state: "in_flight" }
      }
      // Expired, either way: a stale receipt is as good as absent, and an
      // expired in-flight lease means the holder never came back.
      await ctx.db.patch(existing._id, {
        state: "in_flight",
        result_json: undefined,
        lease_expires_at: args.now + leaseMs,
        expires_at: args.now + leaseMs,
        updated_at: args.now,
      })
      return { state: "acquired" }
    }
    await ctx.db.insert("control_idempotency", {
      cache_key: args.cache_key,
      fingerprint: args.fingerprint,
      state: "in_flight",
      lease_expires_at: args.now + leaseMs,
      // In-flight rows carry an `expires_at` too, so the sweep can see them.
      // The in-memory layer's equivalent omission is the latent bug W4.2 fixes:
      // an entry with no expiry is neither replayable nor collectable, and a
      // hung request wedges the key permanently.
      expires_at: args.now + leaseMs,
      created_at: args.now,
      updated_at: args.now,
    })
    return { state: "acquired" }
  },
})

export const complete = serviceMutation({
  args: {
    cache_key: v.string(),
    fingerprint: v.string(),
    result_json: v.optional(v.string()),
    now: v.number(),
    ttl_ms: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await row(ctx, args.cache_key)
    // Only the fingerprint that claimed the key may record its result. A
    // mismatch means the row was taken over after this holder's lease lapsed,
    // and the late completion must not overwrite the new holder's work.
    if (!existing || existing.fingerprint !== args.fingerprint) return { recorded: false as const }
    await ctx.db.patch(existing._id, {
      state: "completed",
      ...(args.result_json === undefined ? {} : { result_json: args.result_json }),
      lease_expires_at: 0,
      expires_at: args.now + (args.ttl_ms ?? IDEMPOTENCY_RESULT_TTL_MS),
      updated_at: args.now,
    })
    return { recorded: true as const }
  },
})

/**
 * Release a claim whose operation FAILED, so the client's retry can execute
 * rather than waiting out the lease.
 *
 * A failure is not a result: caching it would turn one transient error into
 * five minutes of replayed errors, which is how the in-memory layer already
 * behaves (it deletes the entry on rejection) and is the behavior to preserve.
 */
export const release = serviceMutation({
  args: { cache_key: v.string(), fingerprint: v.string() },
  handler: async (ctx, args) => {
    const existing = await row(ctx, args.cache_key)
    if (!existing || existing.fingerprint !== args.fingerprint) return { released: false as const }
    // A completed receipt is durable and never withdrawn — same rule as
    // `releaseOrgDeletion`.
    if (existing.state === "completed") return { released: false as const }
    await ctx.db.delete(existing._id)
    return { released: true as const }
  },
})

/**
 * Retire expired rows. Level-triggered: a saturated tick leaves the rest for
 * the next one, and nothing is skipped forever because an expired row stays
 * expired.
 *
 * Ranged on `by_state_expiry` down to just the rows that can possibly match, so
 * the read set is bounded by expired rows rather than by table size (W5's
 * no-unbounded-read invariant).
 */
export const sweepExpired = cronMutation({
  // `now` is optional so the cron can call this with no clock argument; tests
  // pass one to drive expiry deterministically. Reading the clock inside a
  // mutation is fine for a GC decision (nothing downstream depends on the exact
  // instant), unlike the claim paths above where the caller's `now` is what
  // makes lease arithmetic reproducible.
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const limit = Math.min(args.limit ?? IDEMPOTENCY_SWEEP_LIMIT, IDEMPOTENCY_SWEEP_LIMIT)
    let swept = 0
    for (const state of ["in_flight", "completed"] as const) {
      if (swept >= limit) break
      const stale = await ctx.db
        .query("control_idempotency")
        .withIndex("by_state_expiry", (q: any) => q.eq("state", state).lte("expires_at", now))
        .take(limit - swept)
      for (const doc of stale) {
        await ctx.db.delete(doc._id)
        swept += 1
      }
    }
    return { swept }
  },
})
