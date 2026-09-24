import { isLoopbackUrl, resolveServerUrl, type AuthSource, type ServerConfig } from "./config"
import { responseError, responseErrorCode, toAppError } from "./errors"
import { createRelay } from "./relay"

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
}

export function socketUrl(serverUrl: string, path: string) {
  const url = new URL(path, `${serverUrl}/`)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url
}

async function authorization(auth: AuthSource, fresh: boolean): Promise<string | undefined> {
  if (auth.kind === "none") return undefined
  if (auth.kind === "basic") return `Basic ${btoa(`${auth.username}:${auth.password}`)}`
  const token = await auth.token({ fresh })
  return token ? `Bearer ${token}` : undefined
}

async function authorizedInit(config: ServerConfig, init: RequestInit | undefined, fresh: boolean): Promise<RequestInit> {
  const headers = new Headers(init?.headers)
  const header = await authorization(config.auth, fresh)
  if (header) headers.set("Authorization", header)
  if (typeof init?.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  if (!headers.has("Accept")) headers.set("Accept", "application/json")
  return {
    ...init,
    headers,
    cache: "no-store",
    credentials: config.cookies ? "include" : "same-origin",
  }
}

async function rejectedBearer(response: Response) {
  return response.status === 401 && (await responseErrorCode(response)) === "invalid_bearer_token"
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

export function createTransport(config: ServerConfig): Transport {
  const serverUrl = resolveServerUrl(config)
  const loopback = isLoopbackUrl(serverUrl)

  const send = async (url: string, init?: RequestInit): Promise<Response> => {
    let response: Response
    try {
      response = await fetch(url, await authorizedInit(config, init, false))
    } catch (error) {
      throw toAppError(error)
    }
    if (config.auth.kind !== "bearer" || !(await rejectedBearer(response))) return response
    try {
      return await fetch(url, await authorizedInit(config, init, true))
    } catch (error) {
      throw toAppError(error)
    }
  }

  const request = (path: string, init?: RequestInit) => send(`${serverUrl}${path}`, init)
  const relay = createRelay(request)

  const runtime = (route: RuntimeRoute, path: string, init?: RequestInit) => {
    if (!route.remote) return request(withQuery(path, { directory: route.directory }), init)
    const proxied = withoutRouteQuery(path)
    if (loopback) return request(`/workspaces/${encodeURIComponent(route.workspaceId)}${proxied}`, init)
    return relay.fetch(route.workspaceId, proxied, init)
  }

  const runtimeSocket = async (route: RuntimeRoute, path: string): Promise<WebSocket> => {
    if (!route.remote) return new WebSocket(socketUrl(serverUrl, withQuery(path, { directory: route.directory })))
    const proxied = withoutRouteQuery(path)
    if (loopback) return new WebSocket(socketUrl(serverUrl, `/workspaces/${encodeURIComponent(route.workspaceId)}${proxied}`))
    return relay.webSocket(route.workspaceId, proxied)
  }

  const read = async <T>(response: Response, label: string): Promise<T> => {
    if (!response.ok) throw await responseError(response, label)
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  return {
    serverUrl,
    loopback,
    request,
    runtime,
    runtimeSocket,
    json: async (path, init) => read(await request(path, init), `${init?.method ?? "GET"} ${path}`),
    runtimeJson: async (route, path, init) => read(await runtime(route, path, init), `${init?.method ?? "GET"} ${path}`),
  }
}

export function jsonInit(method: "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown, init?: RequestInit): RequestInit {
  return { ...init, method, body: JSON.stringify(body ?? {}) }
}
