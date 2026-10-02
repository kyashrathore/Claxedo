import { isLoopbackUrl, resolveServerUrl, type ServerConfig } from "./config"
import { createHostedAccount, type HostedAccount } from "./account"
import { responseError, toAppError } from "./errors"
import { createRelay } from "./relay"
import { startWorkspace, type StartOptions } from "./workspace-start"
import type { Placement } from "./types"
import { CLOUD_RUNTIME_UNAVAILABLE, connectionAnswerFromWire, unavailableRetryAfter, type ConnectionAnswer, type WorkspaceConnections } from "./wire/connection"

export type RuntimeRoute = {
  readonly kind: Placement["kind"]
  readonly directory: string
  readonly workspaceId: string
  readonly remote: boolean
}

export type Transport = {
  readonly serverUrl: string
  readonly loopback: boolean
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly runtime: (route: RuntimeRoute, path: string, init?: RequestInit) => Promise<Response>
  readonly runtimeSocket: (route: RuntimeRoute, path: string) => Promise<WebSocket>
  readonly json: <T>(path: string, init?: RequestInit) => Promise<T>
  readonly runtimeJson: <T>(route: RuntimeRoute, path: string, init?: RequestInit) => Promise<T>
  readonly startRuntime: (route: RuntimeRoute, options?: StartOptions) => Promise<void>
}

function socketUrl(serverUrl: string, path: string) {
  const url = new URL(path, `${serverUrl}/`)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url
}

function withRequestDefaults(config: ServerConfig, init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers)
  if (typeof init?.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  if (!headers.has("Accept")) headers.set("Accept", "application/json")
  return {
    ...init,
    headers,
    cache: "no-store",
    credentials: config.cookies ? "include" : "same-origin",
  }
}

export function withQuery(path: string, query: Readonly<Record<string, string | number | boolean | undefined>>) {
  const url = new URL(path, "http://route.local")
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return `${url.pathname}${url.search}`
}

function withoutRouteQuery(path: string) {
  const url = new URL(path, "http://route.local")
  url.searchParams.delete("directory")
  url.searchParams.delete("workspaceId")
  return `${url.pathname}${url.search}`
}

async function fetchFromServer(config: ServerConfig, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, withRequestDefaults(config, init))
  } catch (error) {
    throw toAppError(error)
  }
}

async function readJsonResponse<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) throw await responseError(response, label)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

function workspaceProxyPath(route: RuntimeRoute, path: string) {
  return `/workspaces/${encodeURIComponent(route.workspaceId)}${withoutRouteQuery(path)}`
}

type Request = Transport["request"]

async function requestConnection(request: Request, workspaceId: string, start: boolean): Promise<ConnectionAnswer> {
  const response = await request(`/api/workspace/${encodeURIComponent(workspaceId)}/connection`, start ? { method: "POST", body: "{}" } : undefined)
  if (response.ok) return connectionAnswerFromWire(await response.json(), workspaceId)
  const body = response.clone()
  const error = await responseError(response, start ? "Workspace start" : "Workspace connection")
  const retryAfterMs = start && error.code === CLOUD_RUNTIME_UNAVAILABLE ? unavailableRetryAfter(JSON.parse(await body.text())) : undefined
  if (retryAfterMs === undefined) throw error
  return { kind: "provisioning", retryAfterMs }
}

export function createWorkspaceConnections(request: Request, account?: HostedAccount): WorkspaceConnections {
  return {
    read: async (workspaceId) => account
      ? connectionAnswerFromWire(await account.run("workspace.connection.read", { id: workspaceId }), workspaceId)
      : requestConnection(request, workspaceId, false),
    start: async (workspaceId) => account
      ? connectionAnswerFromWire(await account.run("workspace.connection.mint", { id: workspaceId }), workspaceId)
      : requestConnection(request, workspaceId, true),
  }
}

export function createTransport(config: ServerConfig): Transport {
  const serverUrl = resolveServerUrl(config)
  const loopback = isLoopbackUrl(serverUrl)
  const request = (path: string, init?: RequestInit) => fetchFromServer(config, `${serverUrl}${path}`, init)
  const connections = createWorkspaceConnections(request, config.account ? createHostedAccount(config.account) : undefined)
  const relay = createRelay(connections.read)
  const usesRelay = (route: RuntimeRoute) => (route.kind === "cloud" || route.remote) && (!loopback || config.account !== undefined)
  const runtime = (route: RuntimeRoute, path: string, init?: RequestInit) => {
    if (usesRelay(route)) return relay.fetch(route.workspaceId, withoutRouteQuery(path), init)
    return request(route.remote ? workspaceProxyPath(route, path) : withQuery(path, { directory: route.directory }), init)
  }
  const runtimeSocket = async (route: RuntimeRoute, path: string): Promise<WebSocket> => {
    if (usesRelay(route)) return relay.webSocket(route.workspaceId, withoutRouteQuery(path))
    return new WebSocket(socketUrl(serverUrl, route.remote ? workspaceProxyPath(route, path) : withQuery(path, { directory: route.directory })))
  }
  const label = (path: string, init?: RequestInit) => `${init?.method ?? "GET"} ${path}`
  return {
    serverUrl,
    loopback,
    request,
    runtime,
    runtimeSocket,
    json: async (path, init) => readJsonResponse(await request(path, init), label(path, init)),
    runtimeJson: async (route, path, init) => readJsonResponse(await runtime(route, path, init), label(path, init)),
    startRuntime: async (route, options) => {
      const link = await startWorkspace(connections.start, route.workspaceId, options)
      if (usesRelay(route)) relay.adopt(link)
    },
  }
}

export function jsonInit(method: "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown, init?: RequestInit): RequestInit {
  return { ...init, method, body: JSON.stringify(body ?? {}) }
}
