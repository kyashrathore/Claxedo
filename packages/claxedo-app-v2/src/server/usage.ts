import { queryOptions } from "@tanstack/solid-query"
import type { UnifiedUsageResponse, UsageFilters } from "@claxedo/usage-contract"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"

export type UsageRequest = {
  readonly since: number
  readonly until: number
  readonly timeZone: string
  readonly view?: "quota" | "claxedo" | "total"
  readonly group?: "provider" | "harness" | "model" | "location" | "session" | "workspace" | "app"
  readonly metric?: "tokens" | "cost"
  readonly filters?: UsageFilters
  readonly after?: string
  readonly modelAfter?: string
  readonly limit?: number
}

export type UsageSummary = UnifiedUsageResponse

function usageQuery(input: UsageRequest) {
  const filters = Object.fromEntries(Object.entries(input.filters ?? {}).flatMap(([dimension, value]) => (value ? [[`filter_${dimension}`, value]] : [])))
  return {
    since: input.since,
    until: input.until,
    timezone: input.timeZone,
    view: input.view,
    group: input.group,
    metric: input.metric,
    after: input.after,
    model_after: input.modelAfter,
    limit: input.limit,
    ...filters,
  }
}

export function usageQueries(transport: Transport) {
  return {
    summary: (input: UsageRequest) => queryOptions({
      queryKey: queryKeys.usage(transport.serverUrl, input),
      queryFn: () => transport.json<UsageSummary>(withQuery("/api/claxedo/usage", usageQuery(input))),
    }),
  }
}
