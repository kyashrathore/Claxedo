import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"

export type UsageTotals = {
  turnCount: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  unknownCategories: number
}

export type UsageSeries = { totals: UsageTotals; daily: Array<UsageTotals & { date: string }> }

export type UnifiedUsageResponse = {
  version: 1
  range: { since: number; until: number; timeZone: string }
  quota: { status: "available" | "unavailable" | "degraded"; snapshot?: unknown; error?: string }
  claxedo: UsageSeries & { status: "available" | "stale" | "degraded"; scope: "local" | "cross-machine"; error?: string }
  externalLocal: UsageSeries & {
    status: "available" | "unavailable" | "degraded"
    coverage: Array<{ source: string; status: string; error?: string }>
    unclassified: number
    error?: string
  }
  total: UsageSeries
  sync: { attempted: number; delivered: number; conflicts: number; pending: number }
}

export type UsageRequest = {
  since: number
  until: number
  timeZone: string
  group?: "harness" | "model" | "location" | "session" | "workspace" | "app"
  refresh?: boolean
}

export async function fetchUnifiedUsage(input: UsageRequest): Promise<UnifiedUsageResponse> {
  const serverUrl = getClaxedoServerUrl()
  const target = new URL("/api/claxedo/usage", normalizeUrl(serverUrl) ?? serverUrl)
  target.searchParams.set("since", String(input.since))
  target.searchParams.set("until", String(input.until))
  target.searchParams.set("timezone", input.timeZone)
  if (input.group) target.searchParams.set("group", input.group)
  if (input.refresh) target.searchParams.set("refresh", "1")
  const response = await authFetch(String(target))
  if (!response.ok) throw new Error((await response.text()) || `Usage request failed: ${response.status}`)
  const body = await response.json() as UnifiedUsageResponse
  if (body.version !== 1) throw new Error("Unsupported usage response version")
  return body
}
