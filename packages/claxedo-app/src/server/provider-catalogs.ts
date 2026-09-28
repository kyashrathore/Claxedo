import type { QueryClient } from "@tanstack/solid-query"
import { fetchQuery } from "./fetch-query"
import type { PlacementId } from "./ids"
import { queryKeys } from "./query-keys"
import { withQuery, type Transport } from "./transport"
import type { FetchQuery } from "./types"
import type { Workspaces } from "./workspaces"
import { providerCatalogFromWire, type ProviderCatalog } from "./wire/provider-catalog"
import { PROVIDERS_PATH } from "./wire/providers"

export type ProviderCatalogQueries = {
  readonly catalog: (harness: string, placementId?: PlacementId) => FetchQuery<ProviderCatalog>
}

export type ProviderCatalogsApi = {
  readonly loadDetail: (harness: string, providerId: string, placementId?: PlacementId) => Promise<void>
}

type CatalogRequest = { readonly view: "summary" } | { readonly provider: string }

const WORKSPACE_CATALOG_HARNESS = "opencode"

function catalogPlacement(harness: string, placementId: PlacementId | undefined) {
  return harness === WORKSPACE_CATALOG_HARNESS ? placementId : undefined
}

function catalogQueryKey(server: string, harness: string, placementId: PlacementId | undefined) {
  return queryKeys.providerCatalog(server, harness, catalogPlacement(harness, placementId))
}

async function readCatalog(transport: Transport, workspaces: Workspaces, harness: string, placementId: PlacementId | undefined, request: CatalogRequest) {
  const placement = catalogPlacement(harness, placementId)
  const workspaceId = placement ? (await workspaces.locate(placement)).workspaceId : undefined
  return providerCatalogFromWire(await transport.json<unknown>(withQuery(PROVIDERS_PATH, { nativeHarness: harness, workspaceId, ...request })), harness)
}

function needsDetail(catalog: ProviderCatalog | undefined, providerId: string): boolean {
  const provider = catalog?.all.find((item) => item.id === providerId)
  if (!provider) return true
  const models = Object.keys(provider.models).length
  return catalog?.connected.includes(providerId) ? models <= 1 : models === 0
}

export function providerCatalogQueries(transport: Transport, workspaces: Workspaces): ProviderCatalogQueries {
  return {
    catalog: (harness, placementId) =>
      fetchQuery(catalogQueryKey(transport.serverUrl, harness, placementId), () => readCatalog(transport, workspaces, harness, placementId, { view: "summary" })),
  }
}

export function createProviderCatalogsApi(transport: Transport, workspaces: Workspaces, queryClient: QueryClient): ProviderCatalogsApi {
  const pending = new Map<string, Promise<void>>()
  const read = async (harness: string, providerId: string, placementId: PlacementId | undefined) => {
    const detail = await readCatalog(transport, workspaces, harness, placementId, { provider: providerId })
    const provider = detail.all.find((item) => item.id === providerId)
    if (!provider) throw new Error(`Provider ${providerId} was not returned by the runtime`)
    queryClient.setQueryData<ProviderCatalog>(catalogQueryKey(transport.serverUrl, harness, placementId), (current) =>
      current ? { all: current.all.map((item) => (item.id === providerId ? provider : item)), connected: detail.connected, default: detail.default } : detail,
    )
  }
  return {
    loadDetail: (harness, providerId, placementId) => {
      const id = `${harness}\n${catalogPlacement(harness, placementId) ?? ""}\n${providerId}`
      const running = pending.get(id)
      if (running) return running
      if (!needsDetail(queryClient.getQueryData<ProviderCatalog>(catalogQueryKey(transport.serverUrl, harness, placementId)), providerId)) return Promise.resolve()
      const task = read(harness, providerId, placementId).finally(() => pending.delete(id))
      pending.set(id, task)
      return task
    },
  }
}
