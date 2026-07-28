import { v } from "convex/values"
import { cronMutation, serviceMutation, serviceQuery } from "./model"

const workspaceId = { workspace_id: v.string() }
const status = v.union(
  v.literal("acquiring"),
  v.literal("ready"),
  v.literal("unavailable"),
  v.literal("stopped"),
  v.literal("destroyed"),
)

// `null` clears the stored field; an absent key leaves it unchanged.
const leasePatch = v.object({
  status: v.optional(status),
  sandbox_id: v.optional(v.string()),
  url: v.optional(v.string()),
  host_id: v.optional(v.string()),
  driver_resource_id: v.optional(v.string()),
  retry_count: v.optional(v.number()),
  next_retry_at: v.optional(v.union(v.number(), v.null())),
  last_error: v.optional(v.union(v.string(), v.null())),
  last_heartbeat_at: v.optional(v.number()),
  last_activity_at: v.optional(v.number()),
  labels: v.optional(v.any()),
  checkpoint: v.optional(v.union(v.any(), v.null())),
  persistence_capabilities: v.optional(v.union(v.any(), v.null())),
  restore_status: v.optional(v.union(v.any(), v.null())),
})

function optionalString(row: Record<string, unknown>, key: string) {
  return typeof row[key] === "string" ? row[key] : undefined
}

function optionalNumber(row: Record<string, unknown>, key: string) {
  return typeof row[key] === "number" ? row[key] : undefined
}

function optionalLabels(row: Record<string, unknown>) {
  const value = row.labels
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
}

function optionalObject(row: Record<string, unknown>, key: string) {
  const value = row[key]
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
}

function canonicalLeaseDocument(row: Record<string, unknown>) {
  const resourceId = optionalString(row, "driver_resource_id")
  const url = optionalString(row, "runtime_url") ?? optionalString(row, "url")
  const labels = optionalLabels(row)
  const checkpoint = optionalObject(row, "checkpoint")
  const persistence = optionalObject(row, "persistence_capabilities")
  const restore = optionalObject(row, "restore_status")
  const orgId = optionalString(row, "org_id")
  const userId = optionalString(row, "user_id")
  const startedAt = optionalNumber(row, "started_at")
  const endedAt = optionalNumber(row, "ended_at")
  return {
    workspace_id: optionalString(row, "workspace_id") ?? "",
    home_region: optionalString(row, "home_region") ?? "us-east",
    // W5 metering identity + clock. Spread conditionally so an absent value
    // stays ABSENT rather than becoming an explicit undefined key — the
    // canonical document is written with `db.replace`, so a key that is present
    // and empty is indistinguishable from a tenant we recorded as blank.
    ...(orgId ? { org_id: orgId } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...(startedAt === undefined ? {} : { started_at: startedAt }),
    ...(endedAt === undefined ? {} : { ended_at: endedAt }),
    ...(optionalString(row, "driver") ? { driver: optionalString(row, "driver") } : {}),
    epoch: optionalNumber(row, "epoch") ?? 0,
    status: row.status,
    retry_count: optionalNumber(row, "retry_count") ?? 0,
    ...(optionalString(row, "sandbox_id") ? { sandbox_id: optionalString(row, "sandbox_id") } : {}),
    ...(url ? { runtime_url: url } : {}),
    ...(optionalString(row, "host_id") ? { host_id: optionalString(row, "host_id") } : {}),
    ...(resourceId ? { driver_resource_id: resourceId } : {}),
    ...(optionalNumber(row, "next_retry_at") === undefined ? {} : { next_retry_at: optionalNumber(row, "next_retry_at") }),
    ...(optionalString(row, "last_error") ? { last_error: optionalString(row, "last_error") } : {}),
    ...(optionalNumber(row, "last_heartbeat_at") === undefined ? {} : { last_heartbeat_at: optionalNumber(row, "last_heartbeat_at") }),
    ...(optionalNumber(row, "last_activity_at") === undefined ? {} : { last_activity_at: optionalNumber(row, "last_activity_at") }),
    ...(labels ? { labels } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    ...(persistence ? { persistence_capabilities: persistence } : {}),
    ...(restore ? { restore_status: restore } : {}),
    created_at: optionalNumber(row, "created_at") ?? Date.now(),
    updated_at: optionalNumber(row, "updated_at") ?? Date.now(),
  }
}

function normalizeLease(row: Record<string, unknown>) {
  const lease = canonicalLeaseDocument(row)
  const { runtime_url, ...rest } = lease
  return {
    ...("_id" in row ? { _id: row._id } : {}),
    ...("_creationTime" in row ? { _creationTime: row._creationTime } : {}),
    ...rest,
    ...(runtime_url ? { url: runtime_url } : {}),
  }
}

// Exported for convex/migrations.ts: migration #001 retro-registers the
// legacy-field backfill under the @convex-dev/migrations ledger (D14).
export function hasLegacyLeaseFields(row: Record<string, unknown>) {
  return "provider" in row || "provider_runtime_id" in row
}

export function legacyLeaseDocument(row: Record<string, unknown>) {
  const leaseDriver = optionalString(row, "driver") ?? optionalString(row, "provider")
  const resourceId = optionalString(row, "driver_resource_id") ?? optionalString(row, "provider_runtime_id")
  return canonicalLeaseDocument({
    ...row,
    ...(leaseDriver ? { driver: leaseDriver } : {}),
    ...(resourceId ? { driver_resource_id: resourceId } : {}),
  })
}

// ---------------------------------------------------------------------------
// W5 sandbox-compute metering (metric spec §4.2).
//
// A lease's billable interval opens at `acquire` and closes exactly once, at
// whichever of the three real close paths gets there first: explicit release,
// the reaper's heartbeat-silence transition, or driver-side GC. `active_ms` is
// subtracted from ONE clock (`now - started_at`) rather than assembled from
// two writers, so it cannot drift.
//
// Closing is idempotent by predicate: a row with no `started_at`, or one that
// already carries `ended_at`, has no open interval and writes nothing. That is
// what keeps a reaper sweep re-running over the same stopped lease from
// inventing compute that was never consumed.
// ---------------------------------------------------------------------------

export const closeReason = v.union(
  v.literal("idle_timeout"),
  v.literal("explicit_release"),
  v.literal("gc"),
)

/** `YYYY-MM-DD` in UTC — the rollup's grouping key, stable across regions. */
export function usageDate(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10)
}

/**
 * Write the close fact for a lease's open interval, if it has one. Returns the
 * inserted fact so callers can hand `active_ms` straight to the product-plane
 * event without a second read.
 *
 * A lease with no tenant (pre-W5 rows, or a lease acquired by a path that
 * never carried a signed user) records NOTHING: a fact row keyed on a
 * fabricated org would silently corrupt every per-org aggregate downstream,
 * which is strictly worse than a missing row.
 */
async function closeLeaseInterval(
  ctx: { db: { insert: (table: string, value: Record<string, unknown>) => Promise<unknown> } },
  row: Record<string, unknown>,
  input: { reason: "idle_timeout" | "explicit_release" | "gc"; now: number },
) {
  const startedAt = optionalNumber(row, "started_at")
  const endedAt = optionalNumber(row, "ended_at")
  if (startedAt === undefined || endedAt !== undefined) return null
  const orgId = optionalString(row, "org_id")
  const userId = optionalString(row, "user_id")
  if (!orgId || !userId) return null
  const sandboxId = optionalString(row, "sandbox_id")
  const fact = {
    org_id: orgId,
    user_id: userId,
    workspace_id: optionalString(row, "workspace_id") ?? "",
    ...(sandboxId ? { sandbox_id: sandboxId } : {}),
    driver: optionalString(row, "driver") ?? optionalString(row, "provider") ?? "unknown",
    started_at: startedAt,
    ended_at: input.now,
    active_ms: Math.max(0, input.now - startedAt),
    reason: input.reason,
    date: usageDate(input.now),
    created_at: input.now,
  }
  await ctx.db.insert("sandbox_lease_events", fact)
  return fact
}

export const acquire = serviceMutation({
  args: {
    workspace_id: v.string(),
    home_region: v.string(),
    driver: v.string(),
    stale_after_ms: v.number(),
    // W5: the tenant the lease is being held FOR. Optional so unsigned/local
    // composition keeps working unchanged; absent tenant simply means the
    // interval is never metered.
    org_id: v.optional(v.string()),
    user_id: v.optional(v.string()),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const current = await ctx.db
      .query("runtime_leases")
      .withIndex("by_workspace_id", (q) => q.eq("workspace_id", args.workspace_id))
      .first()
    if (current?.status === "ready") {
      return { acquired: false, lease: normalizeLease(current), retry_after_ms: 0 }
    }
    if (current?.status === "acquiring" && now - current.updated_at < args.stale_after_ms) {
      return {
        acquired: false,
        lease: normalizeLease(current),
        retry_after_ms: Math.max(0, args.stale_after_ms - (now - current.updated_at)),
      }
    }
    const resumable = current?.status === "stopped"
    const next = {
      workspace_id: args.workspace_id,
      home_region: current?.home_region ?? args.home_region,
      driver: current?.driver ?? args.driver,
      // W5: a fresh epoch opens a fresh billable interval. The previous one was
      // already closed by whichever close path ran (release deletes the row;
      // the reaper stamps `ended_at`), so re-stamping here cannot double-count.
      org_id: args.org_id ?? current?.org_id,
      user_id: args.user_id ?? current?.user_id,
      started_at: now,
      ended_at: undefined,
      epoch: (current?.epoch ?? 0) + 1,
      status: "acquiring" as const,
      retry_count: current?.retry_count ?? 0,
      // Failed/unavailable epochs start fresh, but a stopped lease is the
      // explicit persistent-resume state and keeps its driver identity.
      sandbox_id: resumable ? current.sandbox_id : undefined,
      runtime_url: resumable ? current.runtime_url : undefined,
      host_id: resumable ? current.host_id : undefined,
      driver_resource_id: resumable ? current.driver_resource_id : undefined,
      next_retry_at: undefined,
      last_error: undefined,
      last_heartbeat_at: resumable ? current.last_heartbeat_at : undefined,
      last_activity_at: resumable ? current.last_activity_at : undefined,
      labels: resumable ? current.labels : undefined,
      checkpoint: current?.checkpoint,
      persistence_capabilities: current?.persistence_capabilities,
      restore_status: current?.restore_status,
      created_at: current?.created_at ?? now,
      updated_at: now,
    }
    if (current) {
      const lease = canonicalLeaseDocument({ ...current, ...next })
      await ctx.db.replace(current._id, lease)
      return { acquired: true, lease: normalizeLease({ _id: current._id, ...lease }) }
    }
    const id = await ctx.db.insert("runtime_leases", next)
    return { acquired: true, lease: normalizeLease({ _id: id, _creationTime: now, ...next }) }
  },
})

export const update = serviceMutation({
  args: {
    workspace_id: v.string(),
    expected_epoch: v.number(),
    patch: leasePatch,
  },
  handler: async (ctx, args) => {
    const current = await ctx.db
      .query("runtime_leases")
      .withIndex("by_workspace_id", (q) => q.eq("workspace_id", args.workspace_id))
      .first()
    if (!current || current.epoch !== args.expected_epoch) return null
    const {
      next_retry_at,
      last_error,
      url,
      checkpoint,
      persistence_capabilities,
      restore_status,
      ...rest
    } = args.patch
    const next: Record<string, unknown> = {
      ...rest,
      updated_at: Date.now(),
    }
    if (url !== undefined) next.runtime_url = url
    if (next_retry_at !== undefined) next.next_retry_at = next_retry_at === null ? undefined : next_retry_at
    if (last_error !== undefined) next.last_error = last_error === null ? undefined : last_error
    if (checkpoint !== undefined) next.checkpoint = checkpoint === null ? undefined : checkpoint
    if (persistence_capabilities !== undefined) {
      next.persistence_capabilities = persistence_capabilities === null ? undefined : persistence_capabilities
    }
    if (restore_status !== undefined) next.restore_status = restore_status === null ? undefined : restore_status
    const lease = canonicalLeaseDocument({ ...current, ...next })
    await ctx.db.replace(current._id, lease)
    return normalizeLease({ _id: current._id, ...lease })
  },
})

export const recordFailure = serviceMutation({
  args: {
    workspace_id: v.string(),
    expected_epoch: v.number(),
    error: v.string(),
    next_retry_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const current = await ctx.db
      .query("runtime_leases")
      .withIndex("by_workspace_id", (q) => q.eq("workspace_id", args.workspace_id))
      .first()
    if (!current || current.epoch !== args.expected_epoch) return null
    const next = {
      status: "unavailable" as const,
      retry_count: current.retry_count + 1,
      last_error: args.error,
      next_retry_at: args.next_retry_at,
      updated_at: Date.now(),
    }
    const lease = canonicalLeaseDocument({ ...current, ...next })
    await ctx.db.replace(current._id, lease)
    return normalizeLease({ _id: current._id, ...lease })
  },
})

export const release = serviceMutation({
  args: {
    ...workspaceId,
    // W5: why the interval ended. Defaults to the explicit path because that is
    // what this mutation IS — the GC/idle callers pass their own reason.
    reason: v.optional(closeReason),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const current = await ctx.db
      .query("runtime_leases")
      .withIndex("by_workspace_id", (q) => q.eq("workspace_id", args.workspace_id))
      .first()
    if (!current) return { released: false, usage: null }
    // Close BEFORE the delete: the row is the only place the interval's start
    // and tenant live, and after `delete` there is nothing left to subtract.
    const usage = await closeLeaseInterval(ctx, current, {
      reason: args.reason ?? "explicit_release",
      now: args.now ?? Date.now(),
    })
    await ctx.db.delete(current._id)
    return { released: true, usage }
  },
})

/**
 * Stamp the tenant a lease is held for, after the fact.
 *
 * The lease is acquired by the sandbox manager, whose `SandboxLeaseAcquireInput`
 * port carries a workspace and a driver but no tenant — and the acquire happens
 * inside a fire-and-forget provision, several layers below the signed request
 * that authorized it. Rather than thread an org through every driver's store
 * contract, the ONE call site that holds a verified tenant (the hosted cloud
 * workspace create route) stamps it onto the lease it just caused.
 *
 * Write-once by design: a lease already carrying a tenant keeps it, so a retried
 * create cannot re-attribute a running sandbox to a different org.
 */
export const recordTenant = serviceMutation({
  args: {
    ...workspaceId,
    org_id: v.string(),
    user_id: v.string(),
  },
  handler: async (ctx, args) => {
    const current = await ctx.db
      .query("runtime_leases")
      .withIndex("by_workspace_id", (q) => q.eq("workspace_id", args.workspace_id))
      .first()
    if (!current) return { stamped: false, reason: "no_lease" as const }
    if (current.org_id || current.user_id) return { stamped: false, reason: "already_attributed" as const }
    await ctx.db.patch(current._id, {
      org_id: args.org_id,
      user_id: args.user_id,
      updated_at: Date.now(),
    })
    return { stamped: true, reason: null }
  },
})

export const get = serviceQuery({
  args: {
    ...workspaceId,
  },
  handler: async (ctx, args) => {
    const current = await ctx.db
      .query("runtime_leases")
      .withIndex("by_workspace_id", (q) => q.eq("workspace_id", args.workspace_id))
      .first()
    return current ? normalizeLease(current) : null
  },
})

export const list = serviceQuery({
  args: {},
  handler: async (ctx) => {
    return (await ctx.db.query("runtime_leases").collect()).map(normalizeLease)
  },
})

// ---------------------------------------------------------------------------
// D13 lease reaper — Convex-side half of the two-way reconciliation
// (ADR 016 §4 Decision 3).
//
// The split, per the ADR: driver-side convergence (list driver resources,
// destroy orphans) lives in `sandboxManager.garbageCollect()` and is driven by
// a Cloudflare Cron Trigger on the control-plane Worker — Convex has no driver
// credentials and must never grow them. What Convex CAN keep honest is the
// lease table itself, level-triggered from current state:
//
// - an `acquiring` lease that has made no progress far past any legitimate
//   cold-start is a dead in-flight provision (crash between driver-create and
//   lease-write, redeploy mid-acquire). Mark it `unavailable` so the next
//   ensure re-acquires on a fresh epoch; the driver-side sweep destroys
//   whatever the dead epoch created.
// - a `ready` lease whose heartbeat went silent far past the runtime's
//   heartbeat cadence is a lease-table lie (runtime dead, or provider
//   auto-stopped it). Mark it `stopped` — the explicit persistent-resume state
//   — which KEEPS the driver identity (sandbox_id/host_id/driver_resource_id)
//   so a resume-capable driver can pick it back up, while the driver-side
//   sweep reclaims the resource if it is actually orphaned.
//
// Both transitions are idempotent (the predicate no longer matches after the
// write), never touch fresh leases, and honor in-flight state via generous
// grace periods configured in convex/crons.ts. Note: sandbox HOLDS are not a
// Convex concept (they exist only in the local sqlite lease-store shape), so
// there is no hold cleanup here by design.
export const sweepStaleLeases = cronMutation({
  args: {
    acquiring_stale_after_ms: v.number(),
    ready_heartbeat_stale_after_ms: v.number(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now()
    const rows = await ctx.db.query("runtime_leases").collect()
    let markedUnavailable = 0
    let markedStopped = 0
    let closedIntervals = 0
    for (const row of rows) {
      if (row.status === "acquiring" && now - row.updated_at >= args.acquiring_stale_after_ms) {
        await ctx.db.replace(row._id, canonicalLeaseDocument({
          ...row,
          status: "unavailable",
          last_error: `reaper: acquiring lease made no progress for ${now - row.updated_at}ms`,
          updated_at: now,
        }))
        markedUnavailable += 1
        continue
      }
      if (row.status === "ready") {
        const lastSeen = row.last_heartbeat_at ?? row.updated_at
        if (now - lastSeen >= args.ready_heartbeat_stale_after_ms) {
          // W5: ready -> stopped is a real close, so the interval settles here.
          // `closeLeaseInterval` is predicate-idempotent, and stamping
          // `ended_at` means a later sweep over the same stopped row writes
          // nothing — the reaper cannot inflate compute by running often.
          const usage = await closeLeaseInterval(ctx, row, { reason: "idle_timeout", now })
          if (usage) closedIntervals += 1
          await ctx.db.replace(row._id, canonicalLeaseDocument({
            ...row,
            status: "stopped",
            ended_at: now,
            last_error: `reaper: ready lease heartbeat silent for ${now - lastSeen}ms`,
            updated_at: now,
          }))
          markedStopped += 1
        }
      }
    }
    return {
      scanned: rows.length,
      marked_unavailable: markedUnavailable,
      marked_stopped: markedStopped,
      closed_intervals: closedIntervals,
    }
  },
})

// Leases that CLAIM a driver resource but are no longer serving: the
// lease→driver direction of the two-way sweep. The control plane (manual GC
// admin route today, CF-cron-driven `scheduled` handler on the Worker, both
// via `sandboxManager.garbageCollect()`) consumes this to verify/destroy
// driver-side resources — driver calls cannot run inside Convex.
export const listNeedingDriverReconciliation = serviceQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("runtime_leases").collect()
    return rows
      .filter((row) => row.status === "unavailable" || row.status === "stopped" || row.status === "destroyed")
      .filter((row) => Boolean(row.driver_resource_id || row.sandbox_id))
      .map(normalizeLease)
  },
})

// RETIRED as a hand-rolled backfill (D14): superseded by migration #001 in
// convex/migrations.ts, which runs the same normalization under the
// @convex-dev/migrations ledger. The export remains ONLY because the
// break-glass maintenance script
// (packages/claxedo-server/scripts/maintenance/normalize-convex-sandbox-leases.ts)
// still calls it; do not add new callers — new backfills go through
// convex/migrations.ts.
export const normalizeLegacyFields = serviceMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("runtime_leases").collect()
    const legacy = rows.filter(hasLegacyLeaseFields)
    await Promise.all(legacy.map((row) => ctx.db.replace(row._id, legacyLeaseDocument(row))))
    return { scanned: rows.length, updated: legacy.length }
  },
})
