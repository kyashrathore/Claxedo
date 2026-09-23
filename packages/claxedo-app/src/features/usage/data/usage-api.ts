import z from "zod"
import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
import { parseHostedHttpError, signedAccountRun } from "@/platform/account/hosted-control-call"
import { decodeHostedResult } from "@/platform/account/hosted-operations"
import { readArray, readField, readString } from "@/lib/record"
import { errorMessage } from "@/lib/server-errors"
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
 * `await response.json()` is `any`, and the whole usage dashboard indexes
 * nested fields of what it returns, so the answer is parsed here rather than
 * claimed. The `z.ZodType<UnifiedUsageResponse>` annotation keeps the two in
 * step: the schema lives here while the type lives in the contract package,
 * so a field added there and not here stops compiling.
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
    throttledUntil: z.number().optional(),
    refreshing: z.literal(true).optional(),
  }),
  claxedo: z.object({
    ...UsageSeriesShape,
    cost: UsageCostSchema,
    locationShare: z.object({ localTokens: z.number(), cloudTokens: z.number() }),
    status: z.enum(["available", "unavailable", "degraded"]),
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
    unclassifiedRequests: z.number(),
    scannedAt: z.number().optional(),
    error: z.string().optional(),
  }),
  total: z.object(UsageSeriesShape),
  totalCost: UsageCostSchema,
  filterOptions: z.object({ claxedo: UsageFilterOptionsSchema, total: UsageFilterOptionsSchema }),
  breakdown: UsageBreakdownPageSchema.optional(),
  modelBreakdown: UsageBreakdownPageSchema.optional(),
  chart: UsageChartSeriesSchema.optional(),
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

type SignedAccountRun = NonNullable<Awaited<ReturnType<typeof signedAccountRun>>>

/**
 * The signed account's cloud workspace turns in the range, or why they could
 * not be read. A failure is part of the answer rather than the request's: the
 * machine's own usage is still worth drawing without them.
 */
async function cloudUsage(run: SignedAccountRun, input: UsageRequest) {
  try {
    const answer = decodeHostedResult("usage.cloudFacts", await run("usage.cloudFacts", {
      since: input.since,
      until: input.until,
    }))
    return { status: "available" as const, facts: readArray(answer, "facts") ?? [] }
  } catch (error) {
    return { status: "unavailable" as const, error: parseHostedHttpError(error)?.detail ?? errorMessage(error) }
  }
}

/** The refusals a server gives a usage read because of the cloud turns sent with it. */
const CLOUD_PAYLOAD_REFUSALS = ["invalid_cloud_usage", "cloud_usage_too_large"] as const

/**
 * Why the server refused the cloud turns a read carried, or nothing when the
 * refusal, if any, is about the read itself. A body too large for the server
 * is refused before it is read, so any 413 is one.
 */
async function cloudPayloadRefusal(response: Response) {
  if (response.status !== 400 && response.status !== 413) return undefined
  const error = readField(await response.clone().json().catch(() => undefined), "error")
  const code = readString(error, "code")
  if (response.status === 400 && !CLOUD_PAYLOAD_REFUSALS.some((refusal) => refusal === code)) return undefined
  return readString(error, "message") ?? `the server refused them (${response.status})`
}

async function readUsageResponse(response: Response) {
  if (!response.ok) throw new Error((await response.text()) || `Usage request failed: ${response.status}`)
  return UnifiedUsageResponseSchema.parse(await response.json())
}

/**
 * Everything the Usage view draws lives with the server this app talks to:
 * the machine's own plans, transcripts and turns on desktop, the account's
 * cloud turns on the hosted web app. A signed desktop's sidecar holds no
 * account credential, so the account's cloud turns ride along with its
 * request. A server that refuses those turns still answers for the machine:
 * the view reads again without them and says the cloud part is missing.
 */
export async function fetchUnifiedUsage(input: UsageRequest): Promise<UnifiedUsageResponse> {
  const serverUrl = getClaxedoServerUrl()
  const target = new URL("/api/claxedo/usage", normalizeUrl(serverUrl) ?? serverUrl)
  for (const [key, value] of Object.entries(usageQuery(input))) {
    target.searchParams.set(key, String(value))
  }
  const run = input.view === "quota" ? undefined : await signedAccountRun()
  if (!run) return await readUsageResponse(await authFetch(String(target)))
  const withCloud = await authFetch(String(target), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cloud: await cloudUsage(run, input) }),
  })
  const refusal = await cloudPayloadRefusal(withCloud)
  if (refusal === undefined) return await readUsageResponse(withCloud)
  const local = await readUsageResponse(await authFetch(String(target)))
  return {
    ...local,
    claxedo: { ...local.claxedo, status: "degraded", error: `Cloud usage is unavailable: ${refusal}` },
  }
}
