import { QueryClient } from "@tanstack/solid-query"

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

// E2E/debug escape hatch: lets browser automation inspect live query state
// (cache keys, fetch/observer status) without rebuilding. Read-only usage.
if (typeof window !== "undefined") {
  ;(window as typeof window & { __claxedoQueryClient?: QueryClient }).__claxedoQueryClient = queryClient
}
