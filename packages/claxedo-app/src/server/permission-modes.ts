import type { QueryClient } from "@tanstack/solid-query"
import { asRecord } from "@claxedo/helpers/guards"
import { responseError } from "./errors"
import { fetchQuery } from "./fetch-query"
import type { PlacementId } from "./ids"
import { queryKeys } from "./query-keys"
import { sessionEndpoint } from "./session-context"
import { jsonInit, withQuery, type Transport } from "./transport"
import type { FetchQuery, SessionRef } from "./types"
import type { Workspaces } from "./workspaces"
import { harnessSelectionQuery } from "./wire/harness-selection"
import { permissionModeStateFromWire, type PermissionModeState } from "./wire/permission-modes"

export type PermissionModesRequest = { readonly placementId: PlacementId; readonly ref?: SessionRef; readonly harness?: string }

function modesKey(server: string, request: PermissionModesRequest) {
  return request.ref
    ? queryKeys.sessionPermissionModes(server, request.ref.sessionId)
    : queryKeys.draftPermissionModes(server, request.placementId, request.harness ?? "")
}

async function readPermissionModes(transport: Transport, workspaces: Workspaces, request: PermissionModesRequest): Promise<PermissionModeState> {
  const path = request.ref
    ? sessionEndpoint(request.ref, "/permission-mode")
    : withQuery("/permission/modes", request.harness ? harnessSelectionQuery(request.harness) : {})
  const response = await transport.runtime(await workspaces.route(request.ref ?? request.placementId), path)
  if (!response.ok) throw await responseError(response, "Permission modes")
  return permissionModeStateFromWire(await response.json())
}

export function permissionModeQueries(transport: Transport, workspaces: Workspaces) {
  return {
    permissionModes: (request: PermissionModesRequest): FetchQuery<PermissionModeState> =>
      fetchQuery(modesKey(transport.serverUrl, request), () => readPermissionModes(transport, workspaces, request)),
  }
}

export function createPermissionModeWriter(transport: Transport, workspaces: Workspaces, queryClient: QueryClient) {
  return {
    setPermissionMode: async (ref: SessionRef, modeId: string) => {
      const response = await transport.runtime(await workspaces.route(ref), sessionEndpoint(ref, "/permission-mode"), jsonInit("PUT", { modeId }))
      if (!response.ok) throw await responseError(response, "Permission mode")
      const kept = asRecord(asRecord(await response.json())?.config)?.permissionMode
      const currentModeId = typeof kept === "string" ? kept : undefined
      queryClient.setQueryData<PermissionModeState>(
        queryKeys.sessionPermissionModes(transport.serverUrl, ref.sessionId),
        (state) => state && { ...state, ...(currentModeId ? { currentModeId } : {}) },
      )
      return { currentModeId }
    },
    sessionHarnessChanged: (ref: SessionRef) =>
      queryClient.invalidateQueries({ queryKey: queryKeys.sessionPermissionModes(transport.serverUrl, ref.sessionId) }),
  }
}
