import type { QueryClient } from "@tanstack/solid-query"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"
import type { FetchQuery } from "./types"
import { providerCatalogFromWire, type ProviderCatalog } from "./wire/provider-catalog"
import { PROVIDERS_PATH } from "./wire/providers"

export type ProviderCatalogQueries = { readonly catalog: (harness: string) => FetchQuery<ProviderCatalog> }

export type ProviderCatalogsApi = { readonly loadDetail: (harness: string, providerId: string) => Promise<void> }

function needsDetail(catalog: ProviderCatalog | undefined, providerId: string): boolean {
  const provider = catalog?.all.find((item) => item.id === providerId)
  if (!provider) return true
  const models = Object.keys(provider.models).length
  return catalog?.connected.includes(providerId) ? models <= 1 : models === 0
}

export function providerCatalogQueries(transport: Transport): ProviderCatalogQueries {
  return {
    catalog: (harness) =>
      fetchQuery(queryKeys.providerCatalog(transport.serverUrl, harness), async () => providerCatalogFromWire(await transport.json<unknown>(withQuery(PROVIDERS_PATH, { nativeHarness: harness })), harness)),
  }
}

export function createProviderCatalogsApi(transport: Transport, queryClient: QueryClient): ProviderCatalogsApi {
  const pending = new Map<string, Promise<void>>()
  const read = async (harness: string, providerId: string) => {
    const key = queryKeys.providerCatalog(transport.serverUrl, harness)
    const detail = providerCatalogFromWire(await transport.json<unknown>(withQuery(PROVIDERS_PATH, { nativeHarness: harness, provider: providerId })), harness)
    const provider = detail.all.find((item) => item.id === providerId)
    if (!provider) throw new Error(`Provider ${providerId} was not returned by the runtime`)
    queryClient.setQueryData<ProviderCatalog>(key, (current) =>
      current ? { all: current.all.map((item) => (item.id === providerId ? provider : item)), connected: detail.connected, default: detail.default } : detail,
    )
  }
  return {
    loadDetail: (harness, providerId) => {
      const id = `${harness}\n${providerId}`
      const running = pending.get(id)
      if (running) return running
      if (!needsDetail(queryClient.getQueryData<ProviderCatalog>(queryKeys.providerCatalog(transport.serverUrl, harness)), providerId)) return Promise.resolve()
      const task = read(harness, providerId).finally(() => pending.delete(id))
      pending.set(id, task)
      return task
    },
  }
}
