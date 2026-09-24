import { decodeHarnessConnectionsCatalog, type HarnessConnectionsCatalog } from "@claxedo/agent-runtime-contract"
import { responseError } from "./errors"
import type { PlacementId } from "./ids"
import { sessionPath } from "./session-context"
import { jsonInit, withQuery, type Transport } from "./transport"
import type { SessionRef } from "./types"
import type { Workspaces } from "./workspaces"
import { harnessIdentity, harnessSelectionQuery } from "./wire/harness-selection"
import { providerCatalogFromWire, type ProviderCatalog } from "./wire/provider-catalog"
import { PROVIDERS_PATH } from "./wire/providers"

const HARNESS_PATH = "/api/claxedo/agent-config/harness"
const HARNESS_OPTIONS_PATH = "/api/claxedo/agent-config/harness/options"
const CONNECTIONS_PATH = "/api/claxedo/agent-config/connections"

export type HarnessOptionsRequest = {
  readonly placementId: PlacementId
  readonly harness: string
  readonly sessionId?: string
  readonly model?: string
}

export type SessionConfigPatch = {
  readonly harness?: string
  readonly model?: { readonly providerID: string; readonly modelID: string }
  readonly variant?: string
}

export type HarnessConfigApi = {
  readonly serverUrl: string
  /** Today's app keys a workspace by its folder when this machine serves it, and by its workspace id otherwise. */
  readonly workspaceKey: (placementId: PlacementId) => string | undefined
  readonly folderHarness: (placementId: PlacementId, sessionId?: string) => Promise<Response>
  readonly options: (request: HarnessOptionsRequest) => Promise<Response>
  readonly sessionConfig: (ref: SessionRef) => Promise<Response>
  readonly updateSessionConfig: (ref: SessionRef, patch: SessionConfigPatch) => Promise<Response>
  readonly connections: () => Promise<HarnessConnectionsCatalog>
  /** The catalog a catalog harness picks models from; `providerId` asks for that provider's whole model set. */
  readonly providers: (harness: string, providerId?: string) => Promise<ProviderCatalog>
}

export function createHarnessConfigApi(transport: Transport, workspaces: Workspaces): HarnessConfigApi {
  const workspaceId = async (placementId: PlacementId) => (await workspaces.route(placementId)).workspaceId
  return {
    serverUrl: transport.serverUrl,
    workspaceKey: (placementId) => {
      const record = workspaces.catalog()?.placements.find((candidate) => candidate.placement.id === placementId)
      if (!record) return undefined
      return record.route.remote ? record.route.workspaceId : record.route.directory
    },
    folderHarness: async (placementId, sessionId) =>
      transport.request(withQuery(HARNESS_PATH, { workspaceId: await workspaceId(placementId), sessionId })),
    options: async (request) =>
      transport.request(withQuery(HARNESS_OPTIONS_PATH, {
        workspaceId: await workspaceId(request.placementId),
        ...harnessSelectionQuery(request.harness),
        sessionId: request.sessionId,
        model: request.model,
      })),
    sessionConfig: async (ref) => transport.runtime(await workspaces.route(ref), sessionPath(ref, "/config")),
    updateSessionConfig: async (ref, patch) =>
      transport.runtime(await workspaces.route(ref), sessionPath(ref, "/config"), jsonInit("PATCH", {
        ...(patch.harness ? { harness: harnessIdentity(patch.harness) } : {}),
        ...(patch.model ? { model: patch.model } : {}),
        ...(patch.variant !== undefined ? { variant: patch.variant } : {}),
      })),
    connections: async () => {
      const response = await transport.request(CONNECTIONS_PATH)
      if (!response.ok) throw await responseError(response, "Agent connections")
      return decodeHarnessConnectionsCatalog(await response.json())
    },
    providers: async (harness, providerId) =>
      providerCatalogFromWire(await transport.json<unknown>(withQuery(PROVIDERS_PATH, { nativeHarness: harness, provider: providerId })), harness),
  }
}
