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
