import { responseError } from "./errors"
import type { PlacementId } from "./ids"
import { sessionEndpoint } from "./session-context"
import { jsonInit, withQuery, type Transport } from "./transport"
import type { SessionRef } from "./types"
import type { Workspaces } from "./workspaces"
import { harnessSelectionQuery } from "./wire/harness-selection"
import { permissionModeStateFromWire, type PermissionModeState } from "./wire/permission-modes"

export type PermissionModesRequest = { readonly placementId: PlacementId; readonly ref?: SessionRef; readonly harness?: string }

export async function readPermissionModes(transport: Transport, workspaces: Workspaces, request: PermissionModesRequest): Promise<PermissionModeState> {
  const path = request.ref
    ? sessionEndpoint(request.ref, "/permission-mode")
    : withQuery("/permission/modes", request.harness ? harnessSelectionQuery(request.harness) : {})
  const response = await transport.runtime(await workspaces.route(request.ref ?? request.placementId), path)
  if (!response.ok) throw await responseError(response, "Permission modes")
  return permissionModeStateFromWire(await response.json())
}

export async function writePermissionMode(transport: Transport, workspaces: Workspaces, ref: SessionRef, modeId: string): Promise<void> {
  const response = await transport.runtime(await workspaces.route(ref), sessionEndpoint(ref, "/permission-mode"), jsonInit("PUT", { modeId }))
  if (!response.ok) throw await responseError(response, "Permission mode")
}
