import { decodeHarnessConnectionsCatalog, type HarnessConnectionsCatalog } from "@claxedo/agent-runtime-contract"
import { responseError } from "./errors"
import type { PlacementId } from "./ids"
import { sessionEndpoint } from "./session-context"
import { jsonInit, withQuery, type Transport } from "./transport"
import type { SessionRef } from "./types"
import type { Workspaces } from "./workspaces"
import { readHarnessOptions, type HarnessOptionsRequest } from "./harness-options"
import type { HarnessOptions, ModelChoice } from "./types"
import { harnessIdentity, harnessSelectionQuery } from "./wire/harness-selection"
import { permissionModeStateFromWire, type PermissionModeState } from "./wire/permission-modes"

const HARNESS_PATH = "/api/claxedo/agent-config/harness"
const CONNECTIONS_PATH = "/api/claxedo/agent-config/connections"

export type SessionConfigPatch = {
  readonly harness?: string
  readonly model?: ModelChoice
  readonly variant?: string
}

export type HarnessConfigApi = {
  readonly serverUrl: string
  /** Today's app keys a workspace by its folder when this machine serves it, and by its workspace id otherwise. */
  readonly workspaceKey: (placementId: PlacementId) => string | undefined
  readonly folderHarness: (placementId: PlacementId, sessionId?: string) => Promise<Response>
  readonly options: (request: HarnessOptionsRequest) => Promise<HarnessOptions>
  readonly sessionConfig: (ref: SessionRef) => Promise<Response>
  readonly updateSessionConfig: (ref: SessionRef, patch: SessionConfigPatch) => Promise<Response>
  readonly connections: () => Promise<HarnessConnectionsCatalog>
  /** A session's own modes, or for a draft the modes `harness` offers in the placement. */
  readonly permissionModes: (input: { readonly placementId: PlacementId; readonly ref?: SessionRef; readonly harness?: string }) => Promise<PermissionModeState>
  readonly setPermissionMode: (ref: SessionRef, modeId: string) => Promise<PermissionModeState>
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
    options: (request) => readHarnessOptions(transport, workspaces, request),
    sessionConfig: async (ref) => transport.runtime(await workspaces.route(ref), sessionEndpoint(ref, "/config")),
    updateSessionConfig: async (ref, patch) =>
      transport.runtime(await workspaces.route(ref), sessionEndpoint(ref, "/config"), jsonInit("PATCH", {
        ...(patch.harness ? { harness: harnessIdentity(patch.harness) } : {}),
        ...(patch.model ? { model: { providerID: patch.model.providerId, modelID: patch.model.modelId } } : {}),
        ...(patch.variant !== undefined ? { variant: patch.variant } : {}),
      })),
    connections: async () => {
      const response = await transport.request(CONNECTIONS_PATH)
      if (!response.ok) throw await responseError(response, "Agent connections")
      return decodeHarnessConnectionsCatalog(await response.json())
    },
    permissionModes: async (input) => {
      const path = input.ref
        ? sessionEndpoint(input.ref, "/permission-mode")
        : withQuery("/permission/modes", input.harness ? harnessSelectionQuery(input.harness) : {})
      const response = await transport.runtime(await workspaces.route(input.ref ?? input.placementId), path)
      if (!response.ok) throw await responseError(response, "Permission modes")
      return permissionModeStateFromWire(await response.json())
    },
    setPermissionMode: async (ref, modeId) => {
      const response = await transport.runtime(await workspaces.route(ref), sessionEndpoint(ref, "/permission-mode"), jsonInit("PUT", { modeId }))
      if (!response.ok) throw await responseError(response, "Permission mode")
      return permissionModeStateFromWire(await response.json())
    },
  }
}
