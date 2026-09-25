import { responseError } from "./errors"
import type { PlacementId } from "./ids"
import type { QueryClient } from "@tanstack/solid-query"
import { createPermissionModeWriter } from "./permission-modes"
import { withQuery, type Transport } from "./transport"
import type { SessionRef } from "./types"
import type { Workspaces } from "./workspaces"
import { readHarnessOptions, type HarnessOptionsRequest } from "./harness-options"
import type { HarnessOptions, HarnessState, SessionConfig } from "./harness-types"
import { readSessionConfig, writeSessionConfig, type SessionConfigPatch } from "./session-config"
import { harnessStateFromWire } from "./wire/harness-state"
import type { PermissionModeState } from "./wire/permission-modes"

const HARNESS_PATH = "/api/claxedo/agent-config/harness"

export type HarnessConfigApi = {
  readonly serverUrl: string
  /** Today's app keys a workspace by its folder when this machine serves it, and by its workspace id otherwise. */
  readonly workspaceKey: (placementId: PlacementId) => string | undefined
  readonly folderHarness: (placementId: PlacementId, sessionId?: string) => Promise<HarnessState | undefined>
  readonly options: (request: HarnessOptionsRequest) => Promise<HarnessOptions>
  readonly sessionConfig: (ref: SessionRef) => Promise<SessionConfig | undefined>
  readonly updateSessionConfig: (ref: SessionRef, patch: SessionConfigPatch) => Promise<void>
  readonly setPermissionMode: (ref: SessionRef, modeId: string) => Promise<PermissionModeState>
}

export function createHarnessConfigApi(transport: Transport, workspaces: Workspaces, queryClient: QueryClient): HarnessConfigApi {
  const modes = createPermissionModeWriter(transport, workspaces, queryClient)
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
    sessionConfig: (ref) => readSessionConfig(transport, workspaces, ref),
    updateSessionConfig: async (ref, patch) => {
      await writeSessionConfig(transport, workspaces, ref, patch)
      if (patch.harness !== undefined) await modes.sessionHarnessChanged(ref)
    },
    setPermissionMode: modes.setPermissionMode,
  }
}
