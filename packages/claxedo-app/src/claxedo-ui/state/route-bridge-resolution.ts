// Pure route→session resolution helpers and the session-probe URL/config
// builders, split out of route-bridge.tsx so they are unit-testable without
// mounting the reactive route bridge.

import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/shared/data/api"
import { sameWorkspaceDirectory, signedWorkspaceFromProjects } from "../../agent-runtime/signed-workspace"
import { routeSessionHarness } from "./route-session-harness"

export function routeSessionDirectory(sessionDirectory: string | undefined, cacheDirectory: string) {
  if (!sessionDirectory) return cacheDirectory
  return sameWorkspaceDirectory(sessionDirectory, cacheDirectory) ? cacheDirectory : sessionDirectory
}

export function routeKnownSessionDirectory(sessionDirectory: string | undefined, cacheDirectories: string[]) {
  if (!sessionDirectory) return undefined
  return cacheDirectories.find((directory) => sameWorkspaceDirectory(sessionDirectory, directory)) ?? sessionDirectory
}

export function routeSessionWorkspaceBacking(input: {
  projects: Parameters<typeof signedWorkspaceFromProjects>[0]
  directory: string
  workspaceId?: string
}) {
  const workspace =
    signedWorkspaceFromProjects(input.projects, input.directory) ??
    (input.workspaceId ? signedWorkspaceFromProjects(input.projects, input.workspaceId) : undefined)
  if (!workspace) return
  if (input.workspaceId && workspace.workspaceId !== input.workspaceId) return
  return {
    workspaceId: workspace.workspaceId,
    kind: workspace.kind,
  }
}

export function routeBridgeServerUrl(serverUrl: string | undefined) {
  return normalizeUrl(serverUrl) ?? getClaxedoServerUrl()
}

export function routeBridgeSessionMessagesProbeUrl(input: {
  serverUrl?: string
  sessionID: string
  workspaceDirectory: string
}) {
  const url = new URL(
    `/session/${encodeURIComponent(input.sessionID)}/message`,
    routeBridgeServerUrl(input.serverUrl),
  )
  url.searchParams.set("directory", input.workspaceDirectory)
  url.searchParams.set("limit", "1")
  return url
}

export function routeBridgeClaxedoSessionMetaUrl(input: { serverUrl?: string; sessionID: string }) {
  return new URL(
    `/api/claxedo/session/${encodeURIComponent(input.sessionID)}/meta`,
    routeBridgeServerUrl(input.serverUrl),
  )
}

export function routeBridgeSessionConfigUrl(input: {
  serverUrl?: string
  sessionID: string
  workspaceDirectory: string
}) {
  const url = new URL(
    `/session/${encodeURIComponent(input.sessionID)}/config`,
    routeBridgeServerUrl(input.serverUrl),
  )
  url.searchParams.set("directory", input.workspaceDirectory)
  return url
}

export async function routeBridgeSessionConfigHarness(input: {
  serverUrl?: string
  sessionID: string
  workspaceDirectory: string
}) {
  const response = await authFetch(routeBridgeSessionConfigUrl(input)).catch(() => undefined)
  if (!response?.ok) return
  return routeSessionHarness(await response.json().catch(() => undefined))
}

export async function probeRouteSessionDirectory(sessionId: string, directories: string[]) {
  for (const directory of directories.filter((item) => item.startsWith("/")).slice(0, 8)) {
    const response = await authFetch(routeBridgeSessionMessagesProbeUrl({
      serverUrl: getClaxedoServerUrl(),
      sessionID: sessionId,
      workspaceDirectory: directory,
    })).catch(() => undefined)
    if (response?.ok) return directory
  }
  return undefined
}
