import { queryOptions } from "@tanstack/solid-query"
import { fetchUnifiedUsage, type UsageRequest } from "./usage-api"

export const usageQueryKey = (input: UsageRequest) =>
  [
    "usage-dashboard",
    input.since,
    input.until,
    input.timeZone,
    input.view ?? "claxedo",
    input.group ?? "harness",
    input.metric ?? "tokens",
    Object.entries(input.filters ?? {})
      .filter(([, value]) => value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("&"),
    input.after ?? "",
    input.modelAfter ?? "",
    input.limit ?? 25,
    input.refreshNonce ?? 0,
  ] as const

export function unifiedUsageQuery(input: UsageRequest) {
  const queryKey = usageQueryKey(input)
  return queryOptions({
    queryKey,
    queryFn: () => fetchUnifiedUsage(input),
    // Pagination and refreshes can keep the prior snapshot, but a different
    // range, timezone, scope, grouping, metric ordering, or filter set is a different dataset.
    // In particular, never label a 30-day snapshot as 7-day data or render the
    // cheap Claxedo projection as Total while local history is still scanning.
    placeholderData: (previous, previousQuery) => {
      const previousKey = previousQuery?.queryKey
      if (!previousKey) return undefined
      return queryKey.slice(1, 8).every((part, index) => previousKey[index + 1] === part) ? previous : undefined
    },
    staleTime: 60_000,
  })
}
