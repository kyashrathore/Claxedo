import type { NormalizedProviderListResponse } from "@/platform/query/provider-list"
import { mergeProviderIndexWithDetails, providerNeedsDetailHydration } from "@/platform/query/provider-list"
import { queryClient } from "@/platform/query/query-client"

const detailedProviders = new Set<string>()
const pendingProviderDetails = new Map<string, Promise<void>>()

export function providerDetailCacheKey(queryKey: readonly unknown[], providerId: string) {
  return JSON.stringify([...queryKey, providerId])
}

export function setProviderQueryData(
  queryKey: readonly unknown[],
  value: NormalizedProviderListResponse,
) {
  queryClient.setQueryData<NormalizedProviderListResponse | undefined>(
    queryKey,
    (current) => mergeProviderIndexWithDetails(current, value),
  )
}

export function updateProviderQueryData(
  queryKey: readonly unknown[],
  update: (current: NormalizedProviderListResponse | undefined) => NormalizedProviderListResponse,
) {
  queryClient.setQueryData<NormalizedProviderListResponse | undefined>(queryKey, update)
}

export function loadProviderDetailsOnce(
  queryKey: readonly unknown[],
  providerId: string,
  load: () => Promise<void>,
) {
  const key = providerDetailCacheKey(queryKey, providerId)
  const pending = pendingProviderDetails.get(key)
  if (pending) return pending

  const cached = queryClient.getQueryData<NormalizedProviderListResponse>(queryKey)
  if (!providerNeedsDetailHydration(cached, providerId)) {
    detailedProviders.add(key)
    return Promise.resolve()
  }
  // A prior load may have been marked detailed while the cache still holds an
  // index row (persisted storage, merge race, or scope change).
  detailedProviders.delete(key)

  const task = Promise.resolve()
    .then(load)
    .then(() => {
      const after = queryClient.getQueryData<NormalizedProviderListResponse>(queryKey)
      if (!providerNeedsDetailHydration(after, providerId)) detailedProviders.add(key)
    })
    .finally(() => pendingProviderDetails.delete(key))
  pendingProviderDetails.set(key, task)
  return task
}
