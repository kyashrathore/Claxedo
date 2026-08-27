// Pure route→session resolution helpers and the session-probe URL/config
// builders, split out of route-bridge.tsx so they are unit-testable without
// mounting the reactive route bridge.

import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
import { nonCanonicalWorkspaceRouteRedirect } from "@/platform/identity/route"
import { sameWorkspaceDirectory, signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"
import { routeSessionHarness } from "./route-session-harness"

export function settledWorkspaceSessionRedirect(input: {
  hash: string
  isFetching: boolean
  isSuccess: boolean
  pathname: string
  routeId: string | undefined
  search: string
}) {
  if (!input.isSuccess || input.isFetching || input.routeId) return
  const target = nonCanonicalWorkspaceRouteRedirect(input.pathname)
  if (!target || target === input.pathname) return
  return `${target}${input.search}${input.hash}`
}

export function routeSessionDirectory(sessionDirectory: string | undefined, cacheDirectory: string) {
  if (!sessionDirectory) return cacheDirectory
  return sameWorkspaceDirectory(sessionDirectory, cacheDirectory) ? cacheDirectory : sessionDirectory
}

export function routeKnownSessionDirectory(sessionDirectory: string | undefined, cacheDirectories: string[]) {
  if (!sessionDirectory) return undefined
  return cacheDirectories.find((directory) => sameWorkspaceDirectory(sessionDirectory, directory)) ?? sessionDirectory
}

export function routeSessionMetaIsCentral(input: unknown) {
  if (!input || typeof input !== "object") return false
  const row = input as { host?: unknown; sessionRef?: unknown; session_ref?: unknown }
  return row.host === "central" ||
    (typeof row.sessionRef === "string" && row.sessionRef.startsWith("central:")) ||
    (typeof row.session_ref === "string" && row.session_ref.startsWith("central:"))
}

export function routeSessionMetaIsArchived(input: unknown) {
  if (!input || typeof input !== "object") return false
  const row = input as { archived?: unknown; time?: { archived?: unknown } }
  return typeof row.archived === "number" || typeof row.time?.archived === "number"
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

/**
 * The `/api/claxedo/session/<id>/meta` payload shape both route-bridge
 * resolution paths read. All fields are `unknown` on purpose: the route
 * answers for several backends and every consumer narrows per field.
 */
export type RouteSessionMeta = {
  directory?: unknown
  title?: unknown
  tags?: unknown
  workspaceID?: unknown
  workspaceId?: unknown
  harness?: unknown
  runner?: unknown
  harnessType?: unknown
  config?: unknown
  host?: unknown
  sessionRef?: unknown
  session_ref?: unknown
  archived?: unknown
  time?: { archived?: unknown }
}

/**
 * In-flight probe coalescing for the /s/:id resolution fan-out.
 *
 * Two resolution paths (the route-intent adapter's `resolveSession` and the
 * direct-route `resolveRouteSessionFromMeta`) race for the same session id at
 * boot, each fetching the meta and config probes — which showed up as ×2
 * identical GETs in the boot request graph. Keyed by full probe URL and
 * cleared when the request settles, so concurrent callers share one fetch
 * while a later re-resolution still asks the server again.
 */
const inflightSessionProbes = new Map<string, Promise<unknown>>()

function shareSessionProbe<T>(key: string, run: () => Promise<T>): Promise<T> {
  const pending = inflightSessionProbes.get(key)
  if (pending) return pending as Promise<T>
  const request = run().finally(() => inflightSessionProbes.delete(key))
  inflightSessionProbes.set(key, request)
  return request
}

export async function fetchRouteSessionMeta(input: {
  serverUrl?: string
  sessionID: string
  request?: typeof authFetch
}): Promise<RouteSessionMeta | undefined> {
  const url = routeBridgeClaxedoSessionMetaUrl(input)
  return await shareSessionProbe(url.toString(), async () => {
    const response = await (input.request ?? authFetch)(url).catch(() => undefined)
    if (!response?.ok) return undefined
    return await (response.json() as Promise<RouteSessionMeta>).catch(() => undefined)
  })
}

export async function routeBridgeSessionConfigHarness(input: {
  serverUrl?: string
  sessionID: string
  workspaceDirectory: string
  request?: typeof authFetch
}) {
  const url = routeBridgeSessionConfigUrl(input)
  return await shareSessionProbe(url.toString(), async () => {
    const response = await (input.request ?? authFetch)(url).catch(() => undefined)
    if (!response?.ok) return undefined
    return routeSessionHarness(await response.json().catch(() => undefined))
  })
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
