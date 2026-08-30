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
  return hostedControlCall(
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
      const body = (await response.json()) as UnifiedUsageResponse
      if (body.version !== 1) throw new Error("Unsupported usage response version")
      return body
    },
  )
}

export async function syncUsageOutbox(): Promise<{
  attempted: number
  delivered: number
  conflicts: number
  pending: number
}> {
  return hostedControlCall(
    "usage.sync",
    {},
    async () => {
      const serverUrl = getClaxedoServerUrl()
      const target = new URL("/api/claxedo/usage/sync", normalizeUrl(serverUrl) ?? serverUrl)
      const response = await authFetch(String(target), { method: "POST" })
      if (!response.ok) throw new Error((await response.text()) || `Usage sync failed: ${response.status}`)
      return await response.json()
    },
  )
}

export function installUsageOutboxWakeups() {
  const wake = () => {
    void syncUsageOutbox().catch(() => undefined)
  }
  wake()
  window.addEventListener("online", wake)
  return () => window.removeEventListener("online", wake)
}
