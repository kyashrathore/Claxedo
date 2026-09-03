/**
 * What the CURRENT shell route says about the event streams the global-sdk
 * provider must open: the route's directory, the signed workspace that directory
 * belongs to, and whether this surface reaches its event streams through the
 * signed control-plane boundary at all.
 *
 * Split out of `provider.tsx` because it is the provider's route-derived INPUT
 * rather than part of its stream machinery: the provider reads it once per
 * connection attempt, and nothing here touches a stream, a projection, or the
 * emitter. Which SESSION those streams carry is a different question with a
 * different owner — `platform/runtime/session-event-scope.ts`.
 */

import { sameWorkspaceDirectory, type WorkspaceInventoryProject } from "@/platform/runtime/agent/signed-workspace"
import { shellRouteDirectoryFromPathname } from "@/platform/identity/route"
import { isUserHostedWorkspaceDirectory } from "@/platform/identity/legacy-resolver"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { centralTransportForServer } from "@/platform/runtime/transport"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import type { LiveSession } from "../global-sdk-event-fetch"
import { USER_HOSTED_WORKSPACE_KIND } from "@/platform/runtime/agent/workspace-kind"

export function initialRouteDirectory() {
  if (typeof window === "undefined") return
  return shellRouteDirectoryFromPathname(window.location.pathname)
}

export function cachedProjectInventory(baseUrl?: string) {
  return baseUrl ? queryClient.getQueryData<WorkspaceInventoryProject[]>(queryKeys.controlPlane.projects(baseUrl)) ?? [] : []
}

export function initialRouteWorkspace(baseUrl?: string) {
  const directory = initialRouteDirectory()
  if (!directory) return
  for (const project of cachedProjectInventory(baseUrl)) {
    const match = Object.entries(project.workspaces ?? {})
      .find(([key, workspace]) =>
        (sameWorkspaceDirectory(key, directory) || sameWorkspaceDirectory(workspace.directory, directory)) &&
        (workspace.kind === "cloud" || workspace.kind === USER_HOSTED_WORKSPACE_KIND)
      )
    if (!match) continue
    const [key, workspace] = match
    return {
      directory,
      workspaceId: workspace.workspaceId ?? workspace.id ?? key,
      workspaceKind: workspace.kind ?? undefined,
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
  return !!(directory && sessionWorkspaceRuntimeRef({ directory })) ||
    isUserHostedWorkspaceDirectory(directory)
}
