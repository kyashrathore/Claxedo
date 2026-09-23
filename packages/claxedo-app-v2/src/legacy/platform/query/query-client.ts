import { QueryClient, type QueryKey } from "@tanstack/solid-query"

export const QUERY_CACHE_GC_TIME_MS = 30 * 60 * 1000

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
      gcTime: QUERY_CACHE_GC_TIME_MS,
    },
  },
})

/**
 * Remove one known query without asking `removeQueries` to scan the whole
 * cache. TanStack's filter API hashes the requested key once per cached query,
 * even with `exact: true`; foreground ephemeral-state cleanup must use the
 * cache's canonical query hash index instead.
 */
export function removeExactQuery(queryKey: QueryKey) {
  const queryHash = queryClient.defaultQueryOptions({ queryKey }).queryHash
  const query = queryClient.getQueryCache().get(queryHash)
  if (query) queryClient.getQueryCache().remove(query)
}

// E2E/debug escape hatch: lets browser automation inspect live query state
// (cache keys, fetch/observer status) without rebuilding. Read-only usage.
if (typeof window !== "undefined") {
  ;(window as typeof window & { __claxedoQueryClient?: QueryClient }).__claxedoQueryClient = queryClient
}
