// Convex half of the @claxedo/wakes `WakeStore` adapter (wakes-v2 plan
// 2026-07-17-002 U5). Each port operation is a service-token-guarded function;
// the claxedo-server `ConvexWakeStore` calls these 1:1. Rows are returned in
// the port's camelCase shape (absent optional = null) so the JS adapter stays
// a thin transport.
//
// `createWakeInTx` is the in-transaction creator: other mutations (e.g.
// workgraphCommands) call it so "domain write + wake" is one atomic Convex
// transaction — a crash can never separate them.

import { v } from "convex/values"
import type { GenericMutationCtx, GenericQueryCtx } from "convex/server"
import { serviceMutation, serviceQuery } from "./model"
import type { DataModel, Doc } from "./_generated/dataModel"

type MutationCtx = GenericMutationCtx<DataModel>
type QueryCtx = GenericQueryCtx<DataModel>

const nullableString = v.optional(v.union(v.string(), v.null()))
const nullableNumber = v.optional(v.union(v.number(), v.null()))

/** Port-shape wake row (camelCase, nulls explicit) from a Convex doc. */
function toWake(doc: Doc<"wakes">) {
  return {
    id: doc.id,
    sessionId: doc.session_id ?? null,
    workspaceId: doc.workspace_id,
    triggerType: doc.trigger_type,
    kind: doc.kind,
    serialKey: doc.serial_key ?? null,
    intentJson: doc.intent_json,
    resultJson: doc.result_json ?? null,
    state: doc.state,
    expiresAt: doc.expires_at ?? null,
    depth: doc.depth,
    createdBy: doc.created_by ?? null,
    createdAt: doc.created_at,
    firedAt: doc.fired_at ?? null,
    fireAt: doc.fire_at ?? null,
    schedule: doc.schedule ?? null,
    eventKey: doc.event_key ?? null,
    token: doc.token ?? null,
    prompt: doc.prompt ?? null,
    resolvedBy: doc.resolved_by ?? null,
    idempotencyKey: doc.idempotency_key ?? null,
    leaseUntil: doc.lease_until ?? null,
    attempts: doc.attempts,
  }
}

const wakeFields = {
  id: v.string(),
  sessionId: nullableString,
  workspaceId: v.string(),
  triggerType: v.string(),
  kind: v.string(),
  serialKey: nullableString,
  intentJson: v.string(),
  resultJson: nullableString,
  state: v.string(),
  expiresAt: nullableNumber,
  depth: v.number(),
  createdBy: nullableString,
  createdAt: v.number(),
  firedAt: nullableNumber,
  fireAt: nullableNumber,
  schedule: nullableString,
  eventKey: nullableString,
  token: nullableString,
  prompt: nullableString,
  resolvedBy: nullableString,
  idempotencyKey: nullableString,
  leaseUntil: nullableNumber,
  attempts: v.number(),
}

type WakeInput = {
  id: string
  sessionId?: string | null
  workspaceId: string
  triggerType: string
  kind: string
  serialKey?: string | null
  intentJson: string
  resultJson?: string | null
  state: string
  expiresAt?: number | null
  depth: number
  createdBy?: string | null
  createdAt: number
  firedAt?: number | null
  fireAt?: number | null
  schedule?: string | null
  eventKey?: string | null
  token?: string | null
  prompt?: string | null
  resolvedBy?: string | null
  idempotencyKey?: string | null
  leaseUntil?: number | null
  attempts: number
}

async function byWakeId(ctx: QueryCtx, id: string) {
  return ctx.db
    .query("wakes")
    .withIndex("by_wake_id", (q: any) => q.eq("id", id))
    .unique()
}

async function byIdempotency(ctx: QueryCtx, workspaceId: string, key: string) {
  return ctx.db
    .query("wakes")
    .withIndex("by_idempotency", (q: any) => q.eq("workspace_id", workspaceId).eq("idempotency_key", key))
    .first()
}

/**
 * The in-transaction creator. Idempotency-keyed dedup, insert, returns the
 * durable wake id. Call from any mutation to make the wake atomic with the
 * caller's domain writes.
 */
export async function createWakeInTx(
  ctx: MutationCtx,
  wake: WakeInput,
): Promise<{ wakeId: string; inserted: boolean }> {
  if (wake.idempotencyKey != null) {
    const existing = await byIdempotency(ctx, wake.workspaceId, wake.idempotencyKey)
    if (existing) return { wakeId: existing.id, inserted: false }
  }
  await ctx.db.insert("wakes", {
    id: wake.id,
    session_id: wake.sessionId ?? undefined,
    workspace_id: wake.workspaceId,
    trigger_type: wake.triggerType,
    kind: wake.kind,
    serial_key: wake.serialKey ?? undefined,
    intent_json: wake.intentJson,
    result_json: wake.resultJson ?? undefined,
    state: wake.state,
    expires_at: wake.expiresAt ?? undefined,
    depth: wake.depth,
    created_by: wake.createdBy ?? undefined,
    created_at: wake.createdAt,
    fired_at: wake.firedAt ?? undefined,
    fire_at: wake.fireAt ?? undefined,
    schedule: wake.schedule ?? undefined,
    event_key: wake.eventKey ?? undefined,
    token: wake.token ?? undefined,
    prompt: wake.prompt ?? undefined,
    resolved_by: wake.resolvedBy ?? undefined,
    idempotency_key: wake.idempotencyKey ?? undefined,
    lease_until: wake.leaseUntil ?? undefined,
    attempts: wake.attempts,
  })
  return { wakeId: wake.id, inserted: true }
}

export const insertWake = serviceMutation({
  args: wakeFields,
  handler: async (ctx, args) => {
    const { service_token: _token, ...wake } = args
    const result = await createWakeInTx(ctx, wake as WakeInput)
    return { inserted: result.inserted }
  },
})

/**
 * State-aware lane creator: skip the insert when a PENDING wake of the same
 * kind already waits on this lane (a pending dirty-flag covers every command
 * before it fires). Engine idempotency keys can't express this — they dedup
 * forever, so a fired wake would swallow later commands.
 */
export async function createLaneWakeIfIdle(
  ctx: MutationCtx,
  wake: WakeInput & { serialKey: string },
): Promise<{ wakeId: string; created: boolean }> {
  const pending = await ctx.db
    .query("wakes")
    .withIndex("by_lane_state", (q: any) => q.eq("serial_key", wake.serialKey).eq("state", "pending"))
    .collect()
  const existing = pending.find((doc) => doc.kind === wake.kind)
  if (existing) return { wakeId: existing.id, created: false }
  const result = await createWakeInTx(ctx, wake)
  return { wakeId: result.wakeId, created: true }
}

export const nudgeLaneWake = serviceMutation({
  args: wakeFields,
  handler: async (ctx, args) => {
    const { service_token: _token, ...wake } = args
    if (typeof wake.serialKey !== "string" || !wake.serialKey) {
      throw new Error("nudgeLaneWake requires a serialKey lane")
    }
    return createLaneWakeIfIdle(ctx, wake as WakeInput & { serialKey: string })
  },
})

export const getWake = serviceQuery({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const doc = await byWakeId(ctx, args.id)
    return doc ? toWake(doc) : null
  },
})

export const getWakeByToken = serviceQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("wakes")
      .withIndex("by_token", (q: any) => q.eq("token", args.token))
      .first()
    return doc ? toWake(doc) : null
  },
})

export const getWakeByIdempotencyKey = serviceQuery({
  args: { workspace_id: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    const doc = await byIdempotency(ctx, args.workspace_id, args.key)
    return doc ? toWake(doc) : null
  },
})

// Claim due `at` wakes pending → firing under the lane rules: skip keys that
// already have a firing row, at most one wake per key per batch (earliest
// first), null keys unrestricted. Runs in one Convex transaction, so the
// read-check-write is atomic. `serial_key` scopes: undefined = all lanes,
// null = only null-key wakes, string = that lane.
export const claimDueWakes = serviceMutation({
  args: {
    now: v.number(),
    lease_ms: v.number(),
    limit: v.number(),
    serial_key: nullableString,
  },
  handler: async (ctx, args) => {
    const due = await ctx.db
      .query("wakes")
      .withIndex("by_due", (q: any) => q.eq("trigger_type", "at").eq("state", "pending").lte("fire_at", args.now))
      .collect()
    const scoped = due
      .filter((doc) => doc.fire_at != null)
      .filter((doc) =>
        args.serial_key === undefined
          ? true
          : args.serial_key === null
            ? doc.serial_key === undefined
            : doc.serial_key === args.serial_key,
      )
      .sort((a, b) => a.fire_at! - b.fire_at! || (a.id < b.id ? -1 : 1))
    const claimed: Doc<"wakes">[] = []
    const takenLanes = new Set<string>()
    for (const doc of scoped) {
      if (claimed.length >= Math.max(1, Math.min(500, args.limit))) break
      if (doc.serial_key !== undefined) {
        if (takenLanes.has(doc.serial_key)) continue
        const firing = await ctx.db
          .query("wakes")
          .withIndex("by_lane_state", (q: any) => q.eq("serial_key", doc.serial_key).eq("state", "firing"))
          .first()
        if (firing) continue
        takenLanes.add(doc.serial_key)
      }
      await ctx.db.patch(doc._id, {
        state: "firing",
        lease_until: args.now + args.lease_ms,
        attempts: doc.attempts + 1,
      })
      claimed.push((await ctx.db.get(doc._id))!)
    }
    return claimed.map(toWake)
  },
})

export const casWake = serviceMutation({
  args: {
    id: v.string(),
    from: v.string(),
    to: v.string(),
    patch: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const doc = await byWakeId(ctx, args.id)
    if (!doc || doc.state !== args.from) return false
    const patch: Record<string, unknown> = { state: args.to }
    const patchable: Record<string, string> = {
      resultJson: "result_json",
      leaseUntil: "lease_until",
      firedAt: "fired_at",
      resolvedBy: "resolved_by",
    }
    for (const [key, value] of Object.entries((args.patch ?? {}) as Record<string, unknown>)) {
      const column = patchable[key]
      if (!column) continue
      patch[column] = value ?? undefined
    }
    await ctx.db.patch(doc._id, patch)
    return true
  },
})

export const findPendingWakesByEventKey = serviceQuery({
  args: { event_key: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("wakes")
      .withIndex("by_event_state", (q: any) => q.eq("event_key", args.event_key).eq("state", "pending"))
      .collect()
    return docs.map(toWake)
  },
})

export const findExpirableWakes = serviceQuery({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("wakes")
      .withIndex("by_state_expiry", (q: any) => q.eq("state", "pending").lte("expires_at", args.now))
      .collect()
    return docs.filter((doc) => doc.expires_at != null).map(toWake)
  },
})

export const findReclaimableWakes = serviceQuery({
  args: { now: v.number(), serial_key: nullableString },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("wakes")
      .withIndex("by_state_lease", (q: any) => q.eq("state", "firing").lte("lease_until", args.now))
      .collect()
    return docs
      .filter((doc) => doc.lease_until != null)
      .filter((doc) =>
        args.serial_key === undefined
          ? true
          : args.serial_key === null
            ? doc.serial_key === undefined
            : doc.serial_key === args.serial_key,
      )
      .map(toWake)
  },
})

// Atomic reclaim of lapsed-lease firing rows (the mutation half of
// `findReclaimableWakes`, mirroring SqliteWakeStore.reclaimFiring): re-stamp
// the lease to `now + lease_ms` and return only the rows this call changed.
// Runs in one Convex transaction, so of two concurrent reclaimers exactly one
// commits per row — the other retries against the re-stamped lease and matches
// nothing. This is what lets `runDue`/`recover` re-drive a crashed wake's sink
// without ever handing the same row to two drivers.
export const reclaimFiringWakes = serviceMutation({
  args: { now: v.number(), lease_ms: v.number(), serial_key: nullableString },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("wakes")
      .withIndex("by_state_lease", (q: any) => q.eq("state", "firing").lte("lease_until", args.now))
      .collect()
    const reclaimable = docs
      .filter((doc) => doc.lease_until != null)
      .filter((doc) =>
        args.serial_key === undefined
          ? true
          : args.serial_key === null
            ? doc.serial_key === undefined
            : doc.serial_key === args.serial_key,
      )
    const reclaimed: Doc<"wakes">[] = []
    for (const doc of reclaimable) {
      await ctx.db.patch(doc._id, { lease_until: args.now + args.lease_ms })
      reclaimed.push((await ctx.db.get(doc._id))!)
    }
    return reclaimed.map(toWake)
  },
})

export const listFiringWakes = serviceQuery({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db
      .query("wakes")
      .filter((q) => q.eq(q.field("state"), "firing"))
      .collect()
    return docs.map(toWake)
  },
})

export const listWakesForSession = serviceQuery({
  args: { session_id: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("wakes")
      .withIndex("by_session", (q: any) => q.eq("session_id", args.session_id))
      .collect()
    return docs.map(toWake)
  },
})

export const countLiveWakes = serviceQuery({
  args: { workspace_id: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("wakes")
      .withIndex("by_workspace_state", (q: any) => q.eq("workspace_id", args.workspace_id).eq("state", "pending"))
      .collect()
    return docs.length
  },
})

export const countWakesCreatedSince = serviceQuery({
  args: { workspace_id: v.string(), since: v.number() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("wakes")
      .withIndex("by_workspace_created", (q: any) => q.eq("workspace_id", args.workspace_id).gte("created_at", args.since))
      .collect()
    return docs.length
  },
})

export const getWakeReceipt = serviceQuery({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("wake_receipts")
      .withIndex("by_key", (q: any) => q.eq("key", args.key))
      .unique()
    return doc ? doc.result_json : null
  },
})

export const putWakeReceipt = serviceMutation({
  args: { key: v.string(), result_json: v.string(), now: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("wake_receipts")
      .withIndex("by_key", (q: any) => q.eq("key", args.key))
      .unique()
    if (existing) return null
    await ctx.db.insert("wake_receipts", { key: args.key, result_json: args.result_json, created_at: args.now })
    return null
  },
})

export const gcWakes = serviceMutation({
  args: { before: v.number() },
  handler: async (ctx, args) => {
    // Bounded per call: the store contract returns rows removed; callers can
    // re-invoke. Keeps the transaction small.
    const terminal = ["fired", "expired", "cancelled"]
    let removed = 0
    for (const state of terminal) {
      const docs = await ctx.db
        .query("wakes")
        .filter((q) => q.and(q.eq(q.field("state"), state), q.lt(q.field("created_at"), args.before)))
        .take(200)
      for (const doc of docs) {
        await ctx.db.delete(doc._id)
        removed++
      }
    }
    return removed
  },
})
