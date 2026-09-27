import { responseError } from "./errors"
import type { PlacementId } from "./ids"
import { readPermissionModes, writePermissionMode, type PermissionModesRequest } from "./permission-modes"
import { withQuery, type Transport } from "./transport"
import type { SessionRef } from "./types"
import type { Workspaces } from "./workspaces"
import { readHarnessOptions, type HarnessOptionsRequest } from "./harness-options"
import type { HarnessOptions, HarnessState } from "./harness-types"
import { writeSessionConfig, type SessionConfigPatch } from "./session-config"
import { harnessStateFromWire } from "./wire/harness-state"
import type { PermissionModeState } from "./wire/permission-modes"

const HARNESS_PATH = "/api/claxedo/agent-config/harness"

export type HarnessConfigApi = {
  readonly serverUrl: string
  readonly workspaceKey: (placementId: PlacementId) => string | undefined
  readonly folderHarness: (placementId: PlacementId, sessionId?: string) => Promise<HarnessState | undefined>
  readonly options: (request: HarnessOptionsRequest) => Promise<HarnessOptions>
  readonly updateSessionConfig: (ref: SessionRef, patch: SessionConfigPatch) => Promise<void>
  readonly permissionModes: (request: PermissionModesRequest) => Promise<PermissionModeState>
  readonly setPermissionMode: (ref: SessionRef, modeId: string) => Promise<void>
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
    folderHarness: async (placementId, sessionId) => {
      const response = await transport.request(withQuery(HARNESS_PATH, { workspaceId: await workspaceId(placementId), sessionId }))
      if (!response.ok) throw await responseError(response, "Harness status")
      return harnessStateFromWire(await response.json())
    },
    options: (request) => readHarnessOptions(transport, workspaces, request),
    updateSessionConfig: (ref, patch) => writeSessionConfig(transport, workspaces, ref, patch),
    permissionModes: (request) => readPermissionModes(transport, workspaces, request),
    setPermissionMode: (ref, modeId) => writePermissionMode(transport, workspaces, ref, modeId),
  }
}
