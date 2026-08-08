import { keepPreviousData, queryOptions } from "@tanstack/solid-query"
import { fetchUnifiedUsage, type UsageRequest } from "./usage-api"

export const usageQueryKey = (input: UsageRequest) => [
  "usage-dashboard",
  input.since,
  input.until,
  input.timeZone,
  input.group ?? "harness",
  input.refreshNonce ?? 0,
] as const

export function unifiedUsageQuery(input: UsageRequest) {
  return queryOptions({
    queryKey: usageQueryKey(input),
    queryFn: () => fetchUnifiedUsage(input),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  })
}
