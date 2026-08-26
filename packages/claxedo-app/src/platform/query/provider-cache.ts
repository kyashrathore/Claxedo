import type { NormalizedProviderListResponse } from "@/platform/query/provider-list"
import { mergeProviderIndexWithDetails } from "@/platform/query/provider-list"
import { queryClient } from "@/platform/query/query-client"

const detailedProviders = new Set<string>()
const pendingProviderDetails = new Map<string, Promise<void>>()

export function setProviderQueryData(queryKey: readonly unknown[], value: NormalizedProviderListResponse) {
  queryClient.setQueryData<NormalizedProviderListResponse | undefined>(queryKey, (current) =>
    mergeProviderIndexWithDetails(current, value),
  )
}

export function updateProviderQueryData(
  queryKey: readonly unknown[],
  update: (current: NormalizedProviderListResponse | undefined) => NormalizedProviderListResponse,
) {
  queryClient.setQueryData<NormalizedProviderListResponse | undefined>(queryKey, update)
}

export function loadProviderDetailsOnce(queryKey: readonly unknown[], providerId: string, load: () => Promise<void>) {
  const key = JSON.stringify([...queryKey, providerId])
  if (detailedProviders.has(key)) return Promise.resolve()
  const pending = pendingProviderDetails.get(key)
  if (pending) return pending
  const task = Promise.resolve()
    .then(load)
    .then(() => detailedProviders.add(key))
    .then(() => undefined)
    .finally(() => pendingProviderDetails.delete(key))
  pendingProviderDetails.set(key, task)
  return task
}
