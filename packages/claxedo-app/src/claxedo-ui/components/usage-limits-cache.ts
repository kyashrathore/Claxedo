// target-layer: claxedo-ui/components - single writer for the usage-limits
// query-cache family. The usage-limits popover reads this key via useQuery and
// force-refreshes it through writeUsageLimitsSnapshot(); centralizing both the
// key and the only setQueryData call here keeps the family's cache writes in one
// declared place (see architecture/query-cache-writers.json).
import type { QueryClient } from "@tanstack/solid-query"
import type { UsageLimitsSnapshot } from "../../utils/usage-limits-api"

/** The single TanStack query key for the usage-limits snapshot. */
export const USAGE_LIMITS_QUERY_KEY = ["claxedo", "usage-limits"] as const

/** The only sanctioned writer for the usage-limits query-cache family. */
export function writeUsageLimitsSnapshot(
  queryClient: Pick<QueryClient, "setQueryData">,
  data: UsageLimitsSnapshot,
): void {
  queryClient.setQueryData(USAGE_LIMITS_QUERY_KEY, data)
}
