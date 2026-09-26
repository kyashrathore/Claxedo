import type { FetchQuery } from "./types"

export function fetchQuery<T>(queryKey: readonly unknown[], queryFn: () => Promise<NoInfer<T>>): FetchQuery<T> {
  return { queryKey, queryFn }
}
