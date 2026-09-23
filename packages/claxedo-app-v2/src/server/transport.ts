import { isLoopbackUrl, normalizeServerUrl, type AuthSource, type ServerConfig } from "./config"
import { ServerError, responseError, toAppError } from "./errors"
import { createRelay, type Relay } from "./relay"

export type RuntimeRoute = {
  readonly directory: string
  readonly workspaceId?: string
  readonly remote: boolean
}

export type Transport = {
  readonly serverUrl: string
  readonly loopback: boolean
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly runtime: (route: RuntimeRoute, path: string, init?: RequestInit) => Promise<Response>
  readonly json: <T>(path: string, init?: RequestInit) => Promise<T>
  readonly runtimeJson: <T>(route: RuntimeRoute, path: string, init?: RequestInit) => Promise<T>
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
  if (response.status !== 401) return false
  const body: unknown = await response.clone().json().catch(() => undefined)
  const error = body && typeof body === "object" ? (body as { error?: { code?: unknown } }).error : undefined
  return error?.code === "invalid_bearer_token"
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
  const serverUrl = normalizeServerUrl(config.serverUrl)
  const loopback = isLoopbackUrl(serverUrl)
  let relay: Relay | undefined

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

  const runtime = (route: RuntimeRoute, path: string, init?: RequestInit) => {
    if (!route.remote) return request(withQuery(path, { directory: route.directory }), init)
    if (!route.workspaceId) {
      return Promise.reject(new ServerError({ class: "invalid", message: "A remote placement needs a workspace id" }))
    }
    const proxied = withoutRouteQuery(path)
    if (loopback) return request(`/workspaces/${encodeURIComponent(route.workspaceId)}${proxied}`, init)
    relay ??= createRelay({ request, serverUrl })
    return relay.fetch(route.workspaceId, proxied, init)
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
    json: async (path, init) => read(await request(path, init), `${init?.method ?? "GET"} ${path}`),
    runtimeJson: async (route, path, init) => read(await runtime(route, path, init), `${init?.method ?? "GET"} ${path}`),
  }
}

export function jsonInit(method: "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown, init?: RequestInit): RequestInit {
  return { ...init, method, body: JSON.stringify(body ?? {}) }
}
