/**
 * What the CURRENT shell route says about the workspace whose frames the
 * global-sdk provider is applying: the route's directory, the signed workspace
 * that directory belongs to, and whether this surface's reads of that
 * workspace go through the signed control-plane boundary at all.
 *
 * The provider opens no stream of its own — `ClaxedoEventsProvider` does — but
 * it needs this to stand in for a live session before one is set
 * (`eventLiveSession()`) and to decide `signedControlPlane` for the goal and
 * gap-reset reads (`shouldUseSignedEventAccess()`). Nothing here touches a
 * stream, a projection, or the emitter. Which SESSION the streams carry is a
 * different question with a different owner —
 * `platform/runtime/session-event-scope.ts`.
 */

import { type WorkspaceInventoryProject } from "@/platform/runtime/agent/signed-workspace"
import { sameWorkspaceDirectory } from "@/platform/identity/legacy-resolver"
import { shellRouteDirectoryFromPathname } from "@/platform/identity/route"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { centralTransportForServer } from "@/platform/runtime/transport"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import type { LiveSession } from "./live-session"
import { isRelayHostKind, rowHostKind } from "@/platform/runtime/placement-wire"

export function initialRouteDirectory() {
  if (typeof window === "undefined") return undefined
  return shellRouteDirectoryFromPathname(window.location.pathname)
}

export function cachedProjectInventory(baseUrl?: string) {
  return baseUrl ? queryClient.getQueryData<WorkspaceInventoryProject[]>(queryKeys.controlPlane.projects(baseUrl)) ?? [] : []
}

export function initialRouteWorkspace(baseUrl?: string) {
  const directory = initialRouteDirectory()
  if (!directory) return undefined
  for (const project of cachedProjectInventory(baseUrl)) {
    const match = Object.entries(project.workspaces ?? {})
      .find(([key, workspace]) =>
        (sameWorkspaceDirectory(key, directory) || sameWorkspaceDirectory(workspace.directory, directory)) &&
        isRelayHostKind(rowHostKind(workspace))
      )
    if (!match) continue
    const [key, workspace] = match
    return {
      directory,
      workspaceId: workspace.workspaceId ?? workspace.id ?? key,
      hostKind: rowHostKind(workspace),
    }
  }
  return undefined
}

export function shouldUseSignedEventAccess(input: {
  hasSignedAccess: boolean
  serverUrl?: string
  liveSession?: LiveSession
}) {
  if (!input.hasSignedAccess) return false
  if (initialRouteWorkspace(input.serverUrl)) return true
  if (centralTransportForServer(input.serverUrl) !== "loopback") return true
  const directory = input.liveSession?.directory ?? initialRouteDirectory()
  if (!directory && input.liveSession?.workspaceId) return true
  if (!directory) return true
  return !!(directory && sessionWorkspaceRuntimeRef({ directory }))
}
