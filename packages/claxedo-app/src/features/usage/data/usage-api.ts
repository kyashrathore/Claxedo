import z from "zod"
import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
import { hostedControlCall } from "@/platform/account/hosted-control-call"
import type { UnifiedUsageResponse, UsageFilters } from "@claxedo/usage-contract"
export type {
  UnifiedUsageResponse,
  UsageBreakdownPage,
  UsageBreakdownRow,
  UsageChartSeries,
  UsageCost,
  UsageFilterDimension,
  UsageFilterOptions,
  UsageFilters,
  UsageSeries,
  UsageTotals,
} from "@claxedo/usage-contract"

/**
 * The wire schema for `@claxedo/usage-contract`'s `UnifiedUsageResponse`.
 *
 * `fetchUnifiedUsage` answers through `hostedControlCall`, which has two
 * producers, and neither one established this shape: `usage.get`'s decoder in
 * `HOSTED_OPERATIONS` proves object-ness, and the HTTP branch annotated
 * `await response.json()` — which is `any` — with the contract type. The whole
 * usage dashboard then indexed nested fields on that claim.
 *
 * The `z.ZodType<UnifiedUsageResponse>` annotation is what keeps this honest
 * over time: the schema lives here while the type lives in the contract
 * package, so a field added there and not here stops compiling.
 */
const UsageTotalsShape = {
  turnCount: z.number(),
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  unknownCategories: z.number(),
  partialTurnCount: z.number().optional(),
  unavailableTurnCount: z.number().optional(),
  errorTurnCount: z.number().optional(),
}

const UsageTotalsSchema = z.object(UsageTotalsShape)

const UsageSeriesShape = {
  totals: UsageTotalsSchema,
  daily: z.array(z.object({ ...UsageTotalsShape, date: z.string() })),
}

const UsageCostSchema = z.object({
  estimatedUsd: z.number(),
  pricedTokens: z.number(),
  unpricedTokens: z.number(),
  catalog: z.object({ adapter: z.string(), version: z.string(), source: z.string() }),
  daily: z.array(z.object({
    date: z.string(),
    estimatedUsd: z.number(),
    pricedTokens: z.number(),
    unpricedTokens: z.number(),
  })).optional(),
})

const UsageFilterDimensionSchema = z.enum([
  "app",
  "provider",
  "harness",
  "model",
  "location",
  "session",
  "workspace",
])

const UsageFilterOptionsSchema = z.partialRecord(UsageFilterDimensionSchema, z.array(z.string()))

const UsageBreakdownPageSchema = z.object({
  dimension: UsageFilterDimensionSchema,
  rows: z.array(z.object({
    ...UsageTotalsShape,
    value: z.string(),
    label: z.string(),
    estimatedUsd: z.number(),
    pricedTokens: z.number(),
    unpricedTokens: z.number(),
    status: z.enum(["final", "partial", "unavailable", "unpriced"]),
    href: z.string().optional(),
  })),
  next: z.string().optional(),
})

const UsageChartSeriesSchema = z.object({
  dimension: z.string(),
  series: z.array(z.object({
    value: z.string(),
    label: z.string(),
    daily: z.array(z.object({
      date: z.string(),
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
    })),
  })),
})

const QuotaSnapshotSchema = z.object({
  accounts: z.array(z.object({
    harness: z.string(),
    credentialId: z.string().optional(),
    machineLogin: z.literal(true).optional(),
    label: z.string().optional(),
    plan: z.string().optional(),
    inUse: z.boolean(),
    health: z.enum(["ok", "auth_failed", "no_billing", "rate_capped", "expired"]).optional(),
    windows: z.array(z.object({
      window: z.string(),
      usedPercent: z.number(),
      resetsAt: z.number().nullable(),
    })),
    usageAt: z.number().optional(),
    otherAgent: z.literal(true).optional(),
    usageError: z.string().optional(),
  })),
})

const UnifiedUsageResponseSchema: z.ZodType<UnifiedUsageResponse> = z.object({
  version: z.literal(1),
  range: z.object({ since: z.number(), until: z.number(), timeZone: z.string() }),
  quota: z.object({
    status: z.enum(["available", "unavailable"]),
    snapshot: QuotaSnapshotSchema.optional(),
    error: z.string().optional(),
  }),
  claxedo: z.object({
    ...UsageSeriesShape,
    cost: UsageCostSchema,
    locationShare: z.object({ localTokens: z.number(), cloudTokens: z.number() }),
    status: z.enum(["available", "unavailable", "stale", "degraded"]),
    scope: z.enum(["local", "cross-machine"]),
    error: z.string().optional(),
  }),
  externalLocal: z.object({
    ...UsageSeriesShape,
    cost: UsageCostSchema,
    status: z.enum(["available", "unavailable", "degraded"]),
    coverage: z.array(z.object({
      source: z.string(),
      status: z.enum(["available", "degraded", "unavailable", "unsupported"]),
      error: z.string().optional(),
    })),
    unclassified: z.number(),
    error: z.string().optional(),
  }),
  total: z.object(UsageSeriesShape),
  totalCost: UsageCostSchema,
  filterOptions: z.object({ claxedo: UsageFilterOptionsSchema, total: UsageFilterOptionsSchema }),
  sync: z.object({
    attempted: z.number(),
    delivered: z.number(),
    conflicts: z.number(),
    pending: z.number(),
  }),
  breakdown: UsageBreakdownPageSchema.optional(),
  modelBreakdown: UsageBreakdownPageSchema.optional(),
  chart: UsageChartSeriesSchema.optional(),
})

/**
 * The outbox-sync counters, all optional.
 *
 * `syncUsageOutbox` used to promise four required numbers, but nothing in the
 * repo produces them under those names and its only caller
 * (`installUsageOutboxWakeups`) discards the result entirely. Requiring them
 * would turn a successful sync into a parse failure for a value no one reads.
 */
const UsageSyncResultSchema = z.object({
  attempted: z.number().optional(),
  delivered: z.number().optional(),
  conflicts: z.number().optional(),
  pending: z.number().optional(),
})

export type UsageRequest = {
  since: number
  until: number
  timeZone: string
  view?: "quota" | "claxedo" | "total"
  group?: "provider" | "harness" | "model" | "location" | "session" | "workspace" | "app"
  metric?: "tokens" | "cost"
  filters?: UsageFilters
  after?: string
  modelAfter?: string
  limit?: number
  refreshNonce?: number
}

function usageQuery(input: UsageRequest): Record<string, string | number> {
  const query: Record<string, string | number> = {
    since: input.since,
    until: input.until,
    timezone: input.timeZone,
  }
  if (input.view) query.view = input.view
  if (input.group) query.group = input.group
  if (input.metric) query.metric = input.metric
  for (const [dimension, value] of Object.entries(input.filters ?? {})) {
    if (value) query[`filter_${dimension}`] = value
  }
  if (input.after) query.after = input.after
  if (input.modelAfter) query.model_after = input.modelAfter
  if (input.limit) query.limit = input.limit
  if (input.refreshNonce) query.refresh_nonce = input.refreshNonce
  return query
}

export async function fetchUnifiedUsage(input: UsageRequest): Promise<UnifiedUsageResponse> {
  return UnifiedUsageResponseSchema.parse(await hostedControlCall(
    "usage.get",
    usageQuery(input),
    async () => {
      const serverUrl = getClaxedoServerUrl()
      const target = new URL("/api/claxedo/usage", normalizeUrl(serverUrl) ?? serverUrl)
      for (const [key, value] of Object.entries(usageQuery(input))) {
        target.searchParams.set(key, String(value))
      }
      const response = await authFetch(String(target))
      if (!response.ok) throw new Error((await response.text()) || `Usage request failed: ${response.status}`)
      return await response.json()
    },
  ))
}

export async function syncUsageOutbox(): Promise<{
  attempted?: number
  delivered?: number
  conflicts?: number
  pending?: number
}> {
  return UsageSyncResultSchema.parse(await hostedControlCall(
    "usage.sync",
    {},
    async () => {
      const serverUrl = getClaxedoServerUrl()
      const target = new URL("/api/claxedo/usage/sync", normalizeUrl(serverUrl) ?? serverUrl)
      const response = await authFetch(String(target), { method: "POST" })
      if (!response.ok) throw new Error((await response.text()) || `Usage sync failed: ${response.status}`)
      return await response.json()
    },
  ))
}

export function installUsageOutboxWakeups() {
  const wake = () => {
    void syncUsageOutbox().catch(() => undefined)
  }
  wake()
  window.addEventListener("online", wake)
  return () => window.removeEventListener("online", wake)
}
