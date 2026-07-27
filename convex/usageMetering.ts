// W5 usage metering — the authoritative half of the owner's two cost questions
// ("how much sandbox compute does my average user consume?", "how many AI
// tokens?") and the activation moment that makes both attributable.
//
// D1: this module is the SOURCE OF TRUTH. The same facts are captured to
// PostHog for analysis, but every `capture()` in this codebase is deliberately
// best-effort — a dropped event must never break the turn it observes — which
// is right for product analytics and wrong for a number a paid plan may later
// be gated on. So the server dual-writes: PostHog for the view, these tables
// for the record.
//
// Security law (2026-07-27-003 §5): the Convex function IS the boundary — the
// deployment URL ships inside the web and desktop bundles, so anything not
// built from a service/internal builder is callable by anyone who opens
// devtools. Every function here is `serviceMutation`/`serviceQuery` (verified
// machine principal) or `cronMutation` (internal visibility — not callable by
// any client at all).
//
// And every table here ships a READER. `convex/auditEvents.ts` is write-only
// with zero readers anywhere in the repo; a metering table that nobody can
// query answers no question at all.

import { v } from "convex/values"
import { cronMutation, serviceMutation, serviceQuery, userByClerkSubject } from "./model"
import { usageDate } from "./sandboxLeases"

const turnStatus = v.union(v.literal("ok"), v.literal("error"))

// ---------------------------------------------------------------------------
// AI tokens (metric spec §4.3) + activation (§4.5)
// ---------------------------------------------------------------------------

/**
 * Record one completed model turn, and stamp activation if this is the user's
 * first successful one.
 *
 * Activation lives HERE, in the same transaction as the fact that triggers it,
 * rather than as a follow-up write from the server: a check-and-set split
 * across two round-trips can fire twice under concurrent turns, and
 * "user_activated" firing twice for one user is a silently wrong funnel rather
 * than a visible failure. `activated` in the result is the server's signal to
 * emit the product-plane event exactly once.
 */
export const recordLlmTurn = serviceMutation({
  args: {
    org_id: v.string(),
    user_id: v.string(),
    session_id: v.string(),
    harness: v.string(),
    provider_id: v.string(),
    model_id: v.string(),
    input_tokens: v.number(),
    output_tokens: v.number(),
    reasoning_tokens: v.number(),
    cache_read_tokens: v.number(),
    cache_write_tokens: v.number(),
    turn_status: turnStatus,
    latency_ms: v.number(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const { service_token: _service_token, now: _now, ...fact } = args
    const id = await ctx.db.insert("llm_usage_events", { ...fact, created_at: now })

    // Activation is defined by the metric spec as the first ok turn, so an
    // error turn is recorded as usage and stamps nothing.
    if (args.turn_status !== "ok") return { id, activated: false }
    // `user_id` is the Clerk subject the signed request carried; the user row
    // is keyed by it. An unmatched subject records the usage and stamps
    // nothing — inventing a user row from a metering write would let telemetry
    // create identities.
    const user = await userByClerkSubject(ctx.db, args.user_id)
    if (!user) return { id, activated: false }
    if (typeof user.first_activated_at === "number") return { id, activated: false }
    await ctx.db.patch(user._id, { first_activated_at: now, updated_at: now })
    return { id, activated: true }
  },
})

/** Reader: the staging DoD's "query `llm_usage_events` by `session_id`". */
export const llmUsageForSession = serviceQuery({
  args: { session_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("llm_usage_events")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .collect()
  },
})

/**
 * Reader: "how many AI tokens does my average user consume?" — totals plus the
 * distinct-user count the average divides by, so the answer never depends on a
 * second query agreeing about the denominator.
 */
export const llmUsageTotals = serviceQuery({
  args: {
    org_id: v.optional(v.string()),
    since: v.optional(v.number()),
    until: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const since = args.since ?? 0
    const until = args.until ?? Number.MAX_SAFE_INTEGER
    const rows = (await ctx.db
      .query("llm_usage_events")
      .withIndex("by_created_at", (q) => q.gte("created_at", since).lte("created_at", until))
      .collect())
      .filter((row) => !args.org_id || row.org_id === args.org_id)
    const users = new Set(rows.map((row) => row.user_id))
    const total = (pick: (row: (typeof rows)[number]) => number) => rows.reduce((sum, row) => sum + pick(row), 0)
    const inputTokens = total((row) => row.input_tokens)
    const outputTokens = total((row) => row.output_tokens)
    const reasoningTokens = total((row) => row.reasoning_tokens)
    return {
      turn_count: rows.length,
      user_count: users.size,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      reasoning_tokens: reasoningTokens,
      cache_read_tokens: total((row) => row.cache_read_tokens),
      cache_write_tokens: total((row) => row.cache_write_tokens),
      error_turn_count: rows.filter((row) => row.turn_status === "error").length,
      billable_tokens_per_user: users.size
        ? (inputTokens + outputTokens + reasoningTokens) / users.size
        : 0,
    }
  },
})

// ---------------------------------------------------------------------------
// Sandbox compute (metric spec §4.2)
// ---------------------------------------------------------------------------

/**
 * Reader: the staging DoD's "query the table for that `sandbox_id` and confirm
 * `active_ms` matches wall-clock" — the check that distinguishes a real
 * measurement from "the emit function was called".
 */
export const leaseEventsForSandbox = serviceQuery({
  args: { sandbox_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("sandbox_lease_events")
      .withIndex("by_sandbox_id", (q) => q.eq("sandbox_id", args.sandbox_id))
      .collect()
  },
})

/** Reader: the rollup itself — `AVG(total_active_seconds) GROUP BY date`. */
export const sandboxUsageDaily = serviceQuery({
  args: {
    org_id: v.optional(v.string()),
    from_date: v.optional(v.string()),
    to_date: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rows = (await ctx.db.query("sandbox_usage_daily").collect())
      .filter((row) => !args.org_id || row.org_id === args.org_id)
      .filter((row) => !args.from_date || row.date >= args.from_date)
      .filter((row) => !args.to_date || row.date <= args.to_date)
      .toSorted((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    const users = new Set(rows.map((row) => row.user_id))
    const totalActiveSeconds = rows.reduce((sum, row) => sum + row.total_active_seconds, 0)
    return {
      rows,
      total_active_seconds: totalActiveSeconds,
      lease_count: rows.reduce((sum, row) => sum + row.lease_count, 0),
      user_count: users.size,
      active_seconds_per_user: users.size ? totalActiveSeconds / users.size : 0,
    }
  },
})

/**
 * Roll closed lease intervals into the daily table.
 *
 * Each fact is consumed exactly once: the sweep only reads rows with no
 * `rolled_up_at` and stamps them as it goes, so a re-run — or a run that
 * overlaps the previous one — adds nothing a second time. That is why the
 * rollup accumulates onto the bucket instead of recomputing it.
 */
export const rollupSandboxUsageDaily = cronMutation({
  args: {
    limit: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const pending = (await ctx.db.query("sandbox_lease_events").collect())
      .filter((row) => row.rolled_up_at === undefined)
      .slice(0, args.limit ?? 1000)
    let bucketsWritten = 0
    for (const fact of pending) {
      // Narrowed by date on the index, then matched on the rest in JS: one
      // day's buckets are a small set, and the generic (untyped) db handle the
      // component builders expose does not carry the compound-index shape.
      const bucket = (await ctx.db
        .query("sandbox_usage_daily")
        .withIndex("by_date", (q) => q.eq("date", fact.date))
        .collect())
        .find((row) =>
          row.org_id === fact.org_id
          && row.user_id === fact.user_id
          && row.driver === fact.driver)
      // Seconds, not milliseconds: the rollup is the money-facing unit and
      // `total_active_seconds` is what the owner's question is phrased in.
      const seconds = fact.active_ms / 1000
      if (bucket) {
        await ctx.db.patch(bucket._id, {
          total_active_seconds: bucket.total_active_seconds + seconds,
          lease_count: bucket.lease_count + 1,
          updated_at: now,
        })
      } else {
        await ctx.db.insert("sandbox_usage_daily", {
          org_id: fact.org_id,
          user_id: fact.user_id,
          date: fact.date,
          driver: fact.driver,
          total_active_seconds: seconds,
          lease_count: 1,
          created_at: now,
          updated_at: now,
        })
        bucketsWritten += 1
      }
      await ctx.db.patch(fact._id, { rolled_up_at: now })
    }
    return { rolled_up: pending.length, buckets_created: bucketsWritten }
  },
})

// ---------------------------------------------------------------------------
// Retention (plan D3)
// ---------------------------------------------------------------------------

/**
 * Prune raw fact rows past the retention window; rollups are kept.
 *
 * One row per lease and per turn is unbounded growth at Cloud scale, and
 * `audit_events` shipping with no retention cron is exactly the shape this
 * avoids. A fact is only prunable once it has been rolled up, so pruning can
 * never erase compute the daily table has not yet counted.
 */
export const pruneUsageFacts = cronMutation({
  args: {
    retain_ms: v.number(),
    limit: v.optional(v.number()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const cutoff = now - args.retain_ms
    const limit = args.limit ?? 1000

    const leaseFacts = (await ctx.db
      .query("sandbox_lease_events")
      .withIndex("by_created_at", (q) => q.lt("created_at", cutoff))
      .collect())
      .filter((row) => row.rolled_up_at !== undefined)
      .slice(0, limit)
    for (const row of leaseFacts) await ctx.db.delete(row._id)

    const turnFacts = (await ctx.db
      .query("llm_usage_events")
      .withIndex("by_created_at", (q) => q.lt("created_at", cutoff))
      .collect())
      .slice(0, limit)
    for (const row of turnFacts) await ctx.db.delete(row._id)

    return {
      cutoff,
      lease_events_deleted: leaseFacts.length,
      llm_usage_events_deleted: turnFacts.length,
    }
  },
})

// Re-exported so the metering surface has one import site; the canonical
// definition stays beside the close path that stamps it.
export { usageDate }
