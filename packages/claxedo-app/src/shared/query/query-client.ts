import { QueryClient } from "@tanstack/solid-query"

const day = 1000 * 60 * 60 * 24
const week = day * 7

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
      gcTime: week,
    },
  },
})

// E2E/debug escape hatch: lets browser automation inspect live query state
// (cache keys, fetch/observer status) without rebuilding. Read-only usage.
if (typeof window !== "undefined") {
  ;(window as typeof window & { __claxedoQueryClient?: QueryClient }).__claxedoQueryClient = queryClient
}
