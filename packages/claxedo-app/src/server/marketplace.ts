import { readField } from "@claxedo/helpers/readers"
import type { QueryClient } from "@tanstack/solid-query"
import type { MarketplaceApi } from "./api"
import { contractMismatch, responseError, ServerError } from "./errors"
import { fetchQuery } from "./fetch-query"
import type { ProjectId } from "./ids"
import type {
  MachineInstalled,
  MarketplaceCatalog,
  PluginChange,
  PluginSkillDocument,
  PluginSkillRequest,
  PluginSourceDiagnostic,
  PluginSourceRecord,
} from "./marketplace-types"
import { queryKeys } from "./query-keys"
import { jsonInit, type Transport } from "./transport"
import { pluginChangeFromWire, pluginSourceFromWire, pluginSourcesFromWire } from "./wire/marketplace"
import { marketplaceCatalogFromWire, pluginSkillFromWire } from "./wire/marketplace-catalog"
import { machineInstalledFromWire, sourceDiagnosticsFromWire } from "./wire/marketplace-machine"

const PLUGINS_PATH = "/api/claxedo/plugins"

export class PluginSourceError extends ServerError {
  readonly diagnostics: readonly PluginSourceDiagnostic[]

  constructor(error: ServerError, diagnostics: readonly PluginSourceDiagnostic[]) {
    super({
      class: error.class,
      message: error.message,
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(error.code !== undefined ? { code: error.code } : {}),
    })
    this.name = "PluginSourceError"
    this.diagnostics = diagnostics
  }
}

function catalogPath(projectId: string | undefined, refresh: boolean) {
  const project = projectId ? `/projects/${encodeURIComponent(projectId)}` : ""
  return `${PLUGINS_PATH}${project}${refresh ? "/refresh" : ""}`
}

async function readPluginCatalog(transport: Transport, projectId: string | undefined, refresh: boolean) {
  const catalog = marketplaceCatalogFromWire(await transport.json(catalogPath(projectId, refresh)))
  if (!catalog) throw contractMismatch("plugin catalog")
  return catalog
}

function skillPath(request: PluginSkillRequest) {
  const project = request.projectId ? `/projects/${encodeURIComponent(request.projectId)}` : ""
  const plugin = encodeURIComponent(request.pluginInstanceId)
  return `${PLUGINS_PATH}${project}/${plugin}/skills/${encodeURIComponent(request.skill)}`
}

export function marketplaceQueries(transport: Transport) {
  const server = transport.serverUrl
  return {
    catalog: (projectId?: ProjectId) =>
      fetchQuery<MarketplaceCatalog>(queryKeys.marketplace(server, projectId), () =>
        readPluginCatalog(transport, projectId, false),
      ),
    sources: () =>
      fetchQuery<readonly PluginSourceRecord[]>(queryKeys.marketplaceSources(server), async () => {
        const sources = pluginSourcesFromWire(await transport.json(`${PLUGINS_PATH}/sources`))
        if (!sources) throw contractMismatch("plugin source list")
        return sources
      }),
    skill: (request: PluginSkillRequest) =>
      fetchQuery<PluginSkillDocument>(queryKeys.marketplaceSkill(server, request), async () => {
        const document = pluginSkillFromWire(await transport.json(skillPath(request)))
        if (!document) throw contractMismatch("plugin skill")
        return document
      }),
    machineInstalled: () =>
      fetchQuery<MachineInstalled>(queryKeys.marketplaceMachine(server), async () =>
        machineInstalledFromWire(await transport.json(`${PLUGINS_PATH}/machine-installed`)),
      ),
  }
}

async function postSource(transport: Transport, input: unknown): Promise<PluginSourceRecord> {
  const response = await transport.request(`${PLUGINS_PATH}/sources`, jsonInit("POST", input))
  if (!response.ok) {
    const body: unknown = await response
      .clone()
      .json()
      .catch((error: unknown) => {
        console.warn("The refused plugin source answer carried no JSON diagnostics", error)
        return undefined
      })
    throw new PluginSourceError(await responseError(response, "POST plugin source"), sourceDiagnosticsFromWire(body))
  }
  const source = pluginSourceFromWire(readField(await response.json(), "source"))
  if (!source) throw contractMismatch("plugin source")
  return source
}

function createChanges(transport: Transport, queryClient: QueryClient) {
  const server = transport.serverUrl
  const refreshAll = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.marketplaceAll(server) })
    await queryClient.invalidateQueries({ queryKey: queryKeys.marketplaceSources(server) })
  }
  const changed = async (body: unknown): Promise<PluginChange> => {
    const change = pluginChangeFromWire(body)
    if (!change) throw contractMismatch("plugin change")
    queryClient.setQueriesData<MarketplaceCatalog>({ queryKey: queryKeys.marketplaceAll(server) }, (catalog) =>
      catalog ? { ...catalog, revision: change.revision } : catalog,
    )
    await refreshAll()
    return change
  }
  const post = async (path: string, body: unknown) =>
    changed(await transport.json(`${PLUGINS_PATH}${path}`, jsonInit("POST", body)))
  return { refreshAll, post }
}

export function createMarketplaceApi(transport: Transport, queryClient: QueryClient): MarketplaceApi {
  const server = transport.serverUrl
  const { refreshAll, post } = createChanges(transport, queryClient)
  return {
    refresh: async (projectId) => {
      const catalog = await readPluginCatalog(transport, projectId, true)
      queryClient.setQueryData(queryKeys.marketplace(server, projectId), catalog)
      return catalog
    },
    setActivation: (input) =>
      post("/activation", {
        pluginInstanceId: input.pluginInstanceId,
        harnessIds: input.harnessIds,
        choice: input.choice,
        expectedRevision: input.revision,
        ...(input.target ? { target: input.target } : {}),
      }),
    setOrganizationDefault: (input) =>
      post("/organization-default", {
        pluginInstanceId: input.pluginInstanceId,
        harnessIds: input.harnessIds,
        choice: input.choice,
        expectedRevision: input.revision,
      }),
    update: (pluginInstanceId, revision, authority) =>
      post("/update", { pluginInstanceId, expectedRevision: revision, ...(authority ? { authority } : {}) }),
    addSource: async (input) => {
      const source = await postSource(transport, input)
      await refreshAll()
      return source
    },
    removeSource: async (id) => {
      const response = await transport.request(`${PLUGINS_PATH}/sources/${encodeURIComponent(id)}`, {
        method: "DELETE",
      })
      if (!response.ok && response.status !== 404) throw await responseError(response, "DELETE plugin source")
      await refreshAll()
    },
  }
}
