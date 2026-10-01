import { isLoopbackUrl, resolveServerUrl, type ServerConfig } from "./config"
import { responseError, toAppError } from "./errors"
import { createRelay } from "./relay"
import { startWorkspace, type StartOptions } from "./workspace-start"

export type RuntimeRoute = {
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
  readonly startRuntime: (workspaceId: string, options?: StartOptions) => Promise<void>
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

export function createTransport(config: ServerConfig): Transport {
  const serverUrl = resolveServerUrl(config)
  const loopback = isLoopbackUrl(serverUrl)
  const request = (path: string, init?: RequestInit) => fetchFromServer(config, `${serverUrl}${path}`, init)
  const relay = createRelay(request)
  const runtime = (route: RuntimeRoute, path: string, init?: RequestInit) => {
    if (!route.remote) return request(withQuery(path, { directory: route.directory }), init)
    if (loopback) return request(workspaceProxyPath(route, path), init)
    return relay.fetch(route.workspaceId, withoutRouteQuery(path), init)
  }
  const runtimeSocket = async (route: RuntimeRoute, path: string): Promise<WebSocket> => {
    if (!route.remote) return new WebSocket(socketUrl(serverUrl, withQuery(path, { directory: route.directory })))
    if (loopback) return new WebSocket(socketUrl(serverUrl, workspaceProxyPath(route, path)))
    return relay.webSocket(route.workspaceId, withoutRouteQuery(path))
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
    startRuntime: async (workspaceId, options) => {
      const link = await startWorkspace(request, workspaceId, options)
      if (!loopback) relay.adopt(link)
    },
  }
}

export function jsonInit(method: "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown, init?: RequestInit): RequestInit {
  return { ...init, method, body: JSON.stringify(body ?? {}) }
}
