import { mutationGeneric, queryGeneric } from "convex/server"
import { v } from "convex/values"

const workspaceId = { workspace_id: v.string() }
const serviceTokenArg = { service_token: v.string() }
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
})

function serviceToken() {
  const value = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN?.trim()
  return value ? value : undefined
}

function requireService(token: string) {
  const expected = serviceToken()
  if (!expected || token !== expected) throw new Error("Unauthenticated")
}

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

function canonicalLeaseDocument(row: Record<string, unknown>) {
  const resourceId = optionalString(row, "driver_resource_id")
  const url = optionalString(row, "runtime_url") ?? optionalString(row, "url")
  const labels = optionalLabels(row)
  return {
    workspace_id: optionalString(row, "workspace_id") ?? "",
    home_region: optionalString(row, "home_region") ?? "us-east",
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

function hasLegacyLeaseFields(row: Record<string, unknown>) {
  return "provider" in row || "provider_runtime_id" in row
}

function legacyLeaseDocument(row: Record<string, unknown>) {
  const leaseDriver = optionalString(row, "driver") ?? optionalString(row, "provider")
  const resourceId = optionalString(row, "driver_resource_id") ?? optionalString(row, "provider_runtime_id")
  return canonicalLeaseDocument({
    ...row,
    ...(leaseDriver ? { driver: leaseDriver } : {}),
    ...(resourceId ? { driver_resource_id: resourceId } : {}),
  })
}

export const acquire = mutationGeneric({
  args: {
    ...serviceTokenArg,
    workspace_id: v.string(),
    home_region: v.string(),
    driver: v.string(),
    stale_after_ms: v.number(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireService(args.service_token)
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

export const update = mutationGeneric({
  args: {
    ...serviceTokenArg,
    workspace_id: v.string(),
    expected_epoch: v.number(),
    patch: leasePatch,
  },
  handler: async (ctx, args) => {
    requireService(args.service_token)
    const current = await ctx.db
      .query("runtime_leases")
      .withIndex("by_workspace_id", (q) => q.eq("workspace_id", args.workspace_id))
      .first()
    if (!current || current.epoch !== args.expected_epoch) return null
    const { next_retry_at, last_error, url, ...rest } = args.patch
    const next: Record<string, unknown> = {
      ...rest,
      updated_at: Date.now(),
    }
    if (url !== undefined) next.runtime_url = url
    if (next_retry_at !== undefined) next.next_retry_at = next_retry_at === null ? undefined : next_retry_at
    if (last_error !== undefined) next.last_error = last_error === null ? undefined : last_error
    const lease = canonicalLeaseDocument({ ...current, ...next })
    await ctx.db.replace(current._id, lease)
    return normalizeLease({ _id: current._id, ...lease })
  },
})

export const recordFailure = mutationGeneric({
  args: {
    ...serviceTokenArg,
    workspace_id: v.string(),
    expected_epoch: v.number(),
    error: v.string(),
    next_retry_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireService(args.service_token)
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

export const release = mutationGeneric({
  args: {
    ...serviceTokenArg,
    ...workspaceId,
  },
  handler: async (ctx, args) => {
    requireService(args.service_token)
    const current = await ctx.db
      .query("runtime_leases")
      .withIndex("by_workspace_id", (q) => q.eq("workspace_id", args.workspace_id))
      .first()
    if (!current) return { released: false }
    await ctx.db.delete(current._id)
    return { released: true }
  },
})

export const get = queryGeneric({
  args: {
    ...serviceTokenArg,
    ...workspaceId,
  },
  handler: async (ctx, args) => {
    requireService(args.service_token)
    const current = await ctx.db
      .query("runtime_leases")
      .withIndex("by_workspace_id", (q) => q.eq("workspace_id", args.workspace_id))
      .first()
    return current ? normalizeLease(current) : null
  },
})

export const list = queryGeneric({
  args: serviceTokenArg,
  handler: async (ctx, args) => {
    requireService(args.service_token)
    return (await ctx.db.query("runtime_leases").collect()).map(normalizeLease)
  },
})

export const normalizeLegacyFields = mutationGeneric({
  args: serviceTokenArg,
  handler: async (ctx, args) => {
    requireService(args.service_token)
    const rows = await ctx.db.query("runtime_leases").collect()
    const legacy = rows.filter(hasLegacyLeaseFields)
    await Promise.all(legacy.map((row) => ctx.db.replace(row._id, legacyLeaseDocument(row))))
    return { scanned: rows.length, updated: legacy.length }
  },
})
