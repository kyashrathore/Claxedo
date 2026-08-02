/**
 * W4.4 — a fenced, expiring lease so only ONE isolate runs a given cron body.
 *
 * ## The incident this exists for
 *
 * `packages/claxedo-server/src/workgraph-host/reconcile-serialize.ts` records
 * it: overlapping WorkGraph reconciles contend on the same durable work and
 * "hung the Workers runtime outright" (staging run 29514161976 — "code had hung
 * and would never generate a response"). Two independent guards were built to
 * prevent that (`skipOverlappingReconcile`'s closure flag and
 * `hosted-workgraph-admin.ts`'s `active` boolean), and BOTH are per-isolate:
 * they live in `buildApp`'s memoized closure, so isolate B's flag is false while
 * isolate A is mid-reconcile. Cron and the admin route can each be served by a
 * fresh isolate. The guards were real; their scope was one isolate.
 *
 * ## TTL and takeover are mandatory, not a refinement
 *
 * The motivating failure is a HANG. A lease that never expired would convert
 * one hung holder into a reconciler that never runs again — strictly worse than
 * today's overlap, because today's overlap at least eventually makes progress
 * and a permanent stall never does. So:
 *
 *   - Every lease carries `lease_expires_at`. An expired lease is takeable by
 *     the next caller, no operator action and no unwedge step.
 *   - `fence` increments monotonically on every acquisition. A holder whose
 *     lease was taken over can detect it (`heartbeat`/`release` verify the
 *     fence) and will not clobber the new holder's state when it finally
 *     returns. That is what makes this a FENCED lease rather than just a
 *     mutual-exclusion flag: the zombie is not merely excluded, it is
 *     identifiable.
 *   - A run longer than the TTL must `heartbeat` to keep its claim. Reconcile
 *     is bounded, so the TTL is set well above its normal duration; heartbeat
 *     is there for the tail, not the common case.
 *
 * ## Why not a Durable Object
 *
 * Convex already holds the durable work this lease protects, so the lease and
 * the work commit against the same store and cannot disagree about who is
 * running. A DO would add a second source of truth plus a DO round trip on a
 * path that runs once a minute — the wrong trade for a cron fence, even though
 * it is the right one for the per-request rate limiter (see `rate-limit.ts`'s
 * W3.1 note, which chose the opposite way for the opposite reason).
 */
import { v } from "convex/values"
import { serviceMutation, serviceQuery } from "./model"

/**
 * Default lease window.
 *
 * Bounded above by "how long may a stall persist before the next tick may
 * proceed" and below by "how long does an honest reconcile take". The
 * WorkGraph reconcile lane runs every minute and each pass is bounded work, so
 * 5 minutes lets a slow-but-live pass finish (with heartbeats) while capping a
 * dead holder's blast radius at a handful of skipped ticks.
 */
export const CRON_LEASE_MS = 5 * 60_000

type AcquireResult =
  | { acquired: true; fence: number; lease_expires_at: number; took_over: boolean }
  | { acquired: false; fence: number; lease_expires_at: number }

async function leaseRow(ctx: any, name: string) {
  return ctx.db
    .query("cron_leases")
    .withIndex("by_name", (q: any) => q.eq("name", name))
    .unique()
}

/**
 * Claim `name` for `holder`. Succeeds when the lease is free, expired, or
 * already held by this same holder (a re-entrant tick renews rather than
 * deadlocking itself).
 */
export const acquire = serviceMutation({
  args: {
    name: v.string(),
    holder: v.string(),
    now: v.number(),
    lease_ms: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<AcquireResult> => {
    const leaseMs = args.lease_ms ?? CRON_LEASE_MS
    const expiresAt = args.now + leaseMs
    const existing = await leaseRow(ctx, args.name)
    if (!existing) {
      await ctx.db.insert("cron_leases", {
        name: args.name,
        holder: args.holder,
        fence: 1,
        lease_expires_at: expiresAt,
        created_at: args.now,
        updated_at: args.now,
      })
      return { acquired: true, fence: 1, lease_expires_at: expiresAt, took_over: false }
    }
    const live = existing.lease_expires_at > args.now
    if (live && existing.holder !== args.holder) {
      // Someone else is running it. Refuse — this is the whole point.
      return { acquired: false, fence: existing.fence, lease_expires_at: existing.lease_expires_at }
    }
    // Free, expired, or ours. The fence advances on EVERY acquisition,
    // including a same-holder renewal: a holder that reacquired after its own
    // lease lapsed is, from the store's point of view, indistinguishable from a
    // new one, and must not be able to pass its stale fence off as current.
    const fence = existing.fence + 1
    await ctx.db.patch(existing._id, {
      holder: args.holder,
      fence,
      lease_expires_at: expiresAt,
      updated_at: args.now,
    })
    return { acquired: true, fence, lease_expires_at: expiresAt, took_over: !live }
  },
})

/**
 * Extend a claim mid-run. Fails if the fence moved, which is how a holder
 * whose lease was taken over learns it is a zombie and must abandon the run
 * instead of finishing into someone else's state.
 */
export const heartbeat = serviceMutation({
  args: {
    name: v.string(),
    holder: v.string(),
    fence: v.number(),
    now: v.number(),
    lease_ms: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await leaseRow(ctx, args.name)
    if (!existing || existing.holder !== args.holder || existing.fence !== args.fence) {
      return { held: false as const }
    }
    const expiresAt = args.now + (args.lease_ms ?? CRON_LEASE_MS)
    await ctx.db.patch(existing._id, { lease_expires_at: expiresAt, updated_at: args.now })
    return { held: true as const, lease_expires_at: expiresAt }
  },
})

/**
 * Drop a claim at the end of a run so the next tick starts immediately instead
 * of waiting out the TTL. Fence-checked for the same reason as `heartbeat`: a
 * zombie's late release must not free the CURRENT holder's lease.
 */
export const release = serviceMutation({
  args: { name: v.string(), holder: v.string(), fence: v.number(), now: v.number() },
  handler: async (ctx, args) => {
    const existing = await leaseRow(ctx, args.name)
    if (!existing || existing.holder !== args.holder || existing.fence !== args.fence) {
      return { released: false as const }
    }
    await ctx.db.patch(existing._id, { lease_expires_at: 0, updated_at: args.now })
    return { released: true as const }
  },
})

/** Read-only, for the admin route's 409 and for operators asking who holds it. */
export const get = serviceQuery({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const existing = await leaseRow(ctx, args.name)
    if (!existing) return { found: false as const }
    return {
      found: true as const,
      holder: existing.holder as string,
      fence: existing.fence as number,
      lease_expires_at: existing.lease_expires_at as number,
    }
  },
})
