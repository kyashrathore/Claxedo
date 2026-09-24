import type { QueryClient } from "@tanstack/solid-query"
import type { MarketplaceApi } from "./api"
import { ServerError } from "./errors"
import { fetchQuery } from "./fetch-query"
import type { ProjectId } from "./ids"
import type { MarketplaceCatalog, PluginChange, PluginSourceRecord } from "./marketplace-types"
import { queryKeys } from "./query-keys"
import { jsonInit, withQuery, type Transport } from "./transport"
import { pluginChangeFromWire, pluginSourceFromWire, pluginSourcesFromWire } from "./wire/marketplace"

const PLUGINS_PATH = "/api/claxedo/plugins"

function invalid(what: string): ServerError {
  return new ServerError({ class: "internal", message: `The ${what} answer does not match its contract` })
}

export function marketplaceQueries(transport: Transport) {
  const server = transport.serverUrl
  return {
    catalog: (projectId?: ProjectId) =>
      fetchQuery<MarketplaceCatalog>(queryKeys.marketplace(server, projectId), () => transport.json<MarketplaceCatalog>(withQuery(PLUGINS_PATH, { project: projectId }))),
    sources: () =>
      fetchQuery<readonly PluginSourceRecord[]>(queryKeys.marketplaceSources(server), async () => {
        const sources = pluginSourcesFromWire(await transport.json(`${PLUGINS_PATH}/sources`))
        if (!sources) throw invalid("plugin source list")
        return sources
      }),
  }
}

export function createMarketplaceApi(transport: Transport, queryClient: QueryClient): MarketplaceApi {
  const server = transport.serverUrl
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.marketplaceAll(server) })
    await queryClient.invalidateQueries({ queryKey: queryKeys.marketplaceSources(server) })
  }
  const changed = async (body: unknown): Promise<PluginChange> => {
    const change = pluginChangeFromWire(body)
    if (!change) throw invalid("plugin change")
    queryClient.setQueriesData<MarketplaceCatalog>({ queryKey: queryKeys.marketplaceAll(server) }, (catalog) => (catalog ? { ...catalog, revision: change.revision } : catalog))
    await refresh()
    return change
  }
  return {
    setActivation: async (input) => {
      const body = { pluginInstanceId: input.pluginInstanceId, harnessIds: input.harnessIds, choice: input.choice, expectedRevision: input.revision }
      return changed(await transport.json(`${PLUGINS_PATH}/activation`, jsonInit("POST", body)))
    },
    update: async (pluginInstanceId, revision) => changed(await transport.json(`${PLUGINS_PATH}/update`, jsonInit("POST", { pluginInstanceId, expectedRevision: revision }))),
    addSource: async (input) => {
      const body = await transport.json<{ source?: unknown }>(`${PLUGINS_PATH}/sources`, jsonInit("POST", input))
      const source = pluginSourceFromWire(body.source)
      if (!source) throw invalid("plugin source")
      await refresh()
      return source
    },
    removeSource: async (id) => {
      await transport.json(`${PLUGINS_PATH}/sources/${encodeURIComponent(id)}`, { method: "DELETE" })
      await refresh()
    },
  }
}
