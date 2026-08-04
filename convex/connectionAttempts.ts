/**
 * Durable OAuth/device connect attempts — the cross-isolate half of
 * `packages/claxedo-connections/src/attempts.ts`.
 *
 * ## The bug this table exists to close
 *
 * The kit's attempt machine is an in-memory `Map`, and it says so: "Ephemeral
 * by design: a host restart drops pending attempts." That is a fine trade on a
 * single local process, where a restart is rare and visible. On the hosted
 * Worker control plane it is not a trade at all — `createHostedConnectionsSetup`
 * builds a fresh `createConnectionsService` PER REQUEST, so the Map that
 * `POST /:id/connect` wrote the attempt into is already gone by the time
 * `GET /attempts/:state` runs. The poll read an empty Map on every single
 * request and answered `attempt_not_found` 404. Hosted OAuth and device connect
 * could therefore never complete, which is what left a hosted user unable to
 * connect GitHub — and so unable to pick a repository and create a project.
 *
 * ## Semantics are the in-memory store's, not new ones
 *
 * Every rule here is ported deliberately rather than reinvented, because the
 * kit's own tests (`attempts.test.ts`) pin them and both stores must answer
 * alike:
 *
 *   - `consume` is single-use and atomic — it flips `completing`, so a
 *     concurrent poll cannot settle the same attempt twice.
 *   - `peek` is the NON-consuming read device grants poll with; `consume`
 *     cannot serve that, being single-use by design.
 *   - a pending row past its TTL is not consumable and reads as `expired`.
 *   - a MID-CONSUME row (`completing: true`) is left pending past its TTL:
 *     only `settle` may move it, so a slow token exchange still reports its
 *     real outcome instead of a spurious "expired".
 *   - `expire` is distinct from `settle(false)`: only the former is worth
 *     restarting, and collapsing them would tell a user who merely took too
 *     long that authorization was refused.
 *
 * ## No credential material lives here
 *
 * `state` and `verifier` are this flow's own per-attempt random values and
 * `device_code` is the provider's polling handle; all three are dead within the
 * TTL and none authenticates anything on its own. The access token a completed
 * grant yields never reaches this table — `storeDeviceGrant` writes it to the
 * envelope-encrypted credential store, the same sink the local path uses.
 *
 * ## Why `now` is an argument
 *
 * Same convention as `convex/idempotency.ts` and `convex/orgs.ts`: the caller
 * passes the clock so lease/TTL arithmetic is reproducible. `sweepExpired`
 * takes it optionally because a GC decision does not depend on the exact
 * instant.
 */
import { v } from "convex/values"
import { cronMutation, serviceMutation, serviceQuery } from "./model"

/** Mirrors the kit's `ttlMs` default: how long a pending attempt may be finished. */
export const ATTEMPT_TTL_MS = 10 * 60_000

/** Mirrors the kit's `retentionMs`: how long a settled attempt stays readable. */
export const ATTEMPT_RETENTION_MS = 5 * 60_000

/** Rows one sweep tick may retire. Bounds the transaction read set. */
export const ATTEMPT_SWEEP_LIMIT = 500

const scopeValidator = v.union(v.literal("team"), v.literal("personal"))

type Row = {
  _id: any
  state: string
  verifier: string
  integration_id: string
  device_code?: string
  owner?: string
  scope: "team" | "personal"
  status: "pending" | "complete" | "failed" | "expired"
  completing: boolean
  message?: string
  expires_at: number
}

function rowByState(ctx: any, state: string) {
  return ctx.db
    .query("connection_attempts")
    .withIndex("by_state", (q: any) => q.eq("state", state))
    .unique() as Promise<Row | null>
}

/** The `{ status, integrationId, scope, message? }` shape the kit's port returns. */
function summary(row: Row) {
  return {
    status: row.status,
    integrationId: row.integration_id,
    scope: row.scope,
    ...(row.status !== "pending" && row.message ? { message: row.message } : {}),
  }
}

/** Move a pending row to `expired`, starting its retention window. */
async function markExpired(ctx: any, row: Row, now: number) {
  await ctx.db.patch(row._id, {
    status: "expired",
    expires_at: now + ATTEMPT_RETENTION_MS,
    updated_at: now,
  })
}

export const create = serviceMutation({
  args: {
    state: v.string(),
    verifier: v.string(),
    integration_id: v.string(),
    device_code: v.optional(v.string()),
    owner: v.optional(v.string()),
    scope: scopeValidator,
    now: v.number(),
    ttl_ms: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // `state` is 32 random bytes minted by the caller; a collision is either a
    // bug or a replay, and either way the second write must not shadow the
    // first — same rule as `cliSessionTokens.insertRecord`.
    if (await rowByState(ctx, args.state)) throw new Error("Connection attempt already recorded")
    await ctx.db.insert("connection_attempts", {
      state: args.state,
      verifier: args.verifier,
      integration_id: args.integration_id,
      ...(args.device_code === undefined ? {} : { device_code: args.device_code }),
      ...(args.owner === undefined ? {} : { owner: args.owner }),
      scope: args.scope,
      status: "pending",
      completing: false,
      expires_at: args.now + (args.ttl_ms ?? ATTEMPT_TTL_MS),
      created_at: args.now,
      updated_at: args.now,
    })
    return { created: true as const }
  },
})

/**
 * Atomic single-use claim. Returns the pending entry exactly once; unknown,
 * expired, terminal, and already-consuming states all return null.
 *
 * A mutation rather than a query because claiming WRITES the fence — that write
 * is the whole point, and it is what makes two isolates racing the same
 * callback safe.
 */
export const consume = serviceMutation({
  args: { state: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const row = await rowByState(ctx, args.state)
    if (!row || row.status !== "pending" || row.completing) return null
    if (row.expires_at <= args.now) {
      await markExpired(ctx, row, args.now)
      return null
    }
    await ctx.db.patch(row._id, { completing: true, updated_at: args.now })
    return {
      integrationId: row.integration_id,
      ...(row.owner === undefined ? {} : { owner: row.owner }),
      scope: row.scope,
      verifier: row.verifier,
    }
  },
})

/**
 * Non-consuming read for device grants, which poll the SAME attempt many times
 * before it settles.
 *
 * A mutation, not a query, for one reason: an expired peek must RECORD the
 * expiry (the in-memory `peek` does exactly this), or a device attempt that
 * timed out would keep reading as pending forever and the client would poll
 * until its own cap.
 */
export const peek = serviceMutation({
  args: { state: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const row = await rowByState(ctx, args.state)
    if (!row || row.status !== "pending" || row.device_code === undefined) return null
    if (row.expires_at <= args.now) {
      await markExpired(ctx, row, args.now)
      return null
    }
    return {
      integrationId: row.integration_id,
      ...(row.owner === undefined ? {} : { owner: row.owner }),
      scope: row.scope,
      deviceCode: row.device_code,
    }
  },
})

/** Settle a pending attempt as complete or failed. Terminal rows are never re-settled. */
export const settle = serviceMutation({
  args: {
    state: v.string(),
    ok: v.boolean(),
    message: v.optional(v.string()),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await rowByState(ctx, args.state)
    if (!row || row.status !== "pending") return { settled: false as const }
    await ctx.db.patch(row._id, {
      status: args.ok ? "complete" : "failed",
      completing: false,
      ...(args.message ? { message: args.message } : {}),
      expires_at: args.now + ATTEMPT_RETENTION_MS,
      updated_at: args.now,
    })
    return { settled: true as const }
  },
})

/**
 * Settle an attempt the PROVIDER declared expired, as distinct from one that
 * failed. Kept separate for the same reason the in-memory store keeps it:
 * "expired" is worth restarting and "failed" reads as a refusal, and the two
 * carry different copy in the UI.
 */
export const expire = serviceMutation({
  args: { state: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const row = await rowByState(ctx, args.state)
    if (!row || row.status !== "pending") return { expired: false as const }
    await markExpired(ctx, row, args.now)
    return { expired: true as const }
  },
})

/**
 * Read an attempt's status.
 *
 * A pending row past its TTL reads as `expired` WITHOUT being written here — a
 * query cannot write, and the sweep (or the next `consume`/`peek`) records it.
 * The answer is the same either way, which is what matters to the client.
 */
export const status = serviceQuery({
  args: { state: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const row = await rowByState(ctx, args.state)
    if (!row) return null
    if (row.status === "pending" && !row.completing && row.expires_at <= args.now) {
      return { status: "expired" as const, integrationId: row.integration_id, scope: row.scope }
    }
    return summary(row)
  },
})

/**
 * Retire expired rows. Level-triggered: a saturated tick leaves the rest for
 * the next one, and nothing is skipped forever because an expired row stays
 * expired.
 *
 * A PENDING row past its TTL transitions to `expired` (starting its retention
 * window) rather than being deleted outright, so a client that polls once more
 * still learns why its attempt ended. Terminal rows past retention are deleted.
 * Mid-consume rows are skipped entirely — only `settle` may move those.
 *
 * Ranged on `by_status_expiry` so the read set is bounded by expired rows
 * rather than by table size (W5's no-unbounded-read invariant).
 */
export const sweepExpired = cronMutation({
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const limit = Math.min(args.limit ?? ATTEMPT_SWEEP_LIMIT, ATTEMPT_SWEEP_LIMIT)
    let expired = 0
    let deleted = 0

    const stalePending = (await ctx.db
      .query("connection_attempts")
      .withIndex("by_status_expiry", (q: any) => q.eq("status", "pending").lte("expires_at", now))
      .take(limit)) as Row[]
    for (const row of stalePending) {
      // A slow token exchange still owns its attempt; only `settle` may move it.
      if (row.completing) continue
      await markExpired(ctx, row, now)
      expired += 1
    }

    for (const terminal of ["complete", "failed", "expired"] as const) {
      if (deleted + expired >= limit) break
      const rows = (await ctx.db
        .query("connection_attempts")
        .withIndex("by_status_expiry", (q: any) => q.eq("status", terminal).lte("expires_at", now))
        .take(limit - deleted - expired)) as Row[]
      for (const row of rows) {
        await ctx.db.delete(row._id)
        deleted += 1
      }
    }
    return { expired, deleted }
  },
})
