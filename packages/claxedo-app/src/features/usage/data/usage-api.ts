import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
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
  filters?: UsageFilters
  after?: string
  modelAfter?: string
  limit?: number
  refreshNonce?: number
}

export async function fetchUnifiedUsage(input: UsageRequest): Promise<UnifiedUsageResponse> {
  const serverUrl = getClaxedoServerUrl()
  const target = new URL("/api/claxedo/usage", normalizeUrl(serverUrl) ?? serverUrl)
  target.searchParams.set("since", String(input.since))
  target.searchParams.set("until", String(input.until))
  target.searchParams.set("timezone", input.timeZone)
  if (input.view) target.searchParams.set("view", input.view)
  if (input.group) target.searchParams.set("group", input.group)
  for (const [dimension, value] of Object.entries(input.filters ?? {})) {
    if (value) target.searchParams.set(`filter_${dimension}`, value)
  }
  if (input.after) target.searchParams.set("after", input.after)
  if (input.modelAfter) target.searchParams.set("model_after", input.modelAfter)
  if (input.limit) target.searchParams.set("limit", String(input.limit))
  if (input.refreshNonce) target.searchParams.set("refresh_nonce", String(input.refreshNonce))
  const response = await authFetch(String(target))
  if (!response.ok) throw new Error((await response.text()) || `Usage request failed: ${response.status}`)
  const body = (await response.json()) as UnifiedUsageResponse
  if (body.version !== 1) throw new Error("Unsupported usage response version")
  return body
}

export async function syncUsageOutbox(): Promise<{
  attempted: number
  delivered: number
  conflicts: number
  pending: number
}> {
  const serverUrl = getClaxedoServerUrl()
  const target = new URL("/api/claxedo/usage/sync", normalizeUrl(serverUrl) ?? serverUrl)
  const response = await authFetch(String(target), { method: "POST" })
  if (!response.ok) throw new Error((await response.text()) || `Usage sync failed: ${response.status}`)
  return await response.json()
}

export function installUsageOutboxWakeups() {
  const wake = () => {
    void syncUsageOutbox().catch(() => undefined)
  }
  wake()
  window.addEventListener("online", wake)
  return () => window.removeEventListener("online", wake)
}
