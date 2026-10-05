import { isLoopbackUrl, resolveServerUrl, type ServerConfig } from "./config"
import { createHostedAccount, type HostedAccount } from "./account"
import { responseError, toAppError } from "./errors"
import { createRelay, type Relay } from "./relay"
import { startWorkspace, type StartOptions } from "./workspace-start"
import { CLOUD_RUNTIME_UNAVAILABLE, connectionAnswerFromWire, isImageOutdated, unavailableRetryAfter, type ConnectionAnswer, type WorkspaceConnections } from "./wire/connection"
import { SESSION_LIST_SORT, sessionHostRootFromListItem } from "./wire/session-row"
import { asArray, asRecordOrEmpty } from "@claxedo/helpers/guards"
import { ServerError } from "./errors"

export type RuntimeRoute = {
  readonly sharedSession?: { readonly sessionId: string; readonly level: "follow" | "send" }
  readonly sessionHost?: { readonly sessionId: string }
  readonly directory: string
  readonly workspaceId: string
  readonly remote: boolean
}

export type SessionHostListener = (workspaceId: string, sessionId: string, root: string) => void

export type Transport = {
  readonly serverUrl: string
  readonly loopback: boolean
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly runtime: (route: RuntimeRoute, path: string, init?: RequestInit) => Promise<Response>
  readonly runtimeSocket: (route: RuntimeRoute, path: string) => Promise<WebSocket>
  readonly json: (path: string, init?: RequestInit) => Promise<unknown>
  readonly runtimeJson: (route: RuntimeRoute, path: string, init?: RequestInit) => Promise<unknown>
  readonly startRuntime: (workspaceId: string, options?: StartOptions) => Promise<void>
  readonly connectSession: (workspaceId: string, sessionId: string) => Promise<void>
  readonly findSessionHost: (workspaceId: string, sessionId: string) => Promise<string | undefined>
  readonly onSessionHost: (listener: SessionHostListener) => () => void
  readonly onImageOutdated: (listener: (workspaceId: string) => void) => () => void
}

function socketUrl(serverUrl: string, path: string) {
  const url = new URL(path, `${serverUrl}/`)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url
}

function withRequestDefaults(config: ServerConfig, init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers)
  const jsonMutation = init?.body === undefined && ["POST", "PUT", "PATCH", "DELETE"].includes(init?.method?.toUpperCase() ?? "GET")
  if ((typeof init?.body === "string" || jsonMutation) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
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

async function readJsonResponse(response: Response, label: string): Promise<unknown> {
  if (!response.ok) throw await responseError(response, label)
  if (response.status === 204) return undefined
  return response.json()
}

function sessionScope(route: RuntimeRoute) {
  return route.sharedSession?.sessionId ?? route.sessionHost?.sessionId
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
    read: async (workspaceId, sessionId) => {
      if (sessionId) {
        const body = account
          ? await account.run("session.connection.read", { id: workspaceId, sessionId })
          : await readJsonResponse(await request(withQuery(`/api/workspace/${encodeURIComponent(workspaceId)}/connection`, { sessionId })), "Session connection")
        return connectionAnswerFromWire(body, workspaceId, sessionId)
      }
      return account
        ? connectionAnswerFromWire(await account.run("workspace.connection.read", { id: workspaceId }), workspaceId)
        : requestConnection(request, workspaceId, false)
    },
    start: async (workspaceId) => account
      ? connectionAnswerFromWire(await account.run("workspace.connection.mint", { id: workspaceId }), workspaceId)
      : requestConnection(request, workspaceId, true),
    mintSession: async (workspaceId, sessionId) => {
      const body = account
        ? await account.run("session.connection.mint", { id: workspaceId, sessionId })
        : await readJsonResponse(await request(`/api/workspace/${encodeURIComponent(workspaceId)}/connection`, jsonInit("POST", { session: { sessionId } })), "Session connection")
      return connectionAnswerFromWire(body, workspaceId, sessionId)
    },
  }
}

function sessionHostSignals() {
  const listeners = new Set<SessionHostListener>()
  return {
    learned: (workspaceId: string, sessionId: string | undefined, answer: ConnectionAnswer) => {
      if (sessionId && answer.kind === "ready" && answer.sessionHostRoot) for (const listener of listeners) listener(workspaceId, sessionId, answer.sessionHostRoot)
      return answer
    },
    onSessionHost: (listener: SessionHostListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function imageOutdatedSignals() {
  const listeners = new Set<(workspaceId: string) => void>()
  return {
    refused: (workspaceId: string, error: unknown) => {
      if (isImageOutdated(error)) for (const listener of listeners) listener(workspaceId)
    },
    onImageOutdated: (listener: (workspaceId: string) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function sessionHostConnector(connections: WorkspaceConnections, relay: Relay, hosts: ReturnType<typeof sessionHostSignals>): Transport["connectSession"] {
  return async (workspaceId, sessionId) => {
    const answer = hosts.learned(workspaceId, sessionId, await connections.mintSession(workspaceId, sessionId))
    if (answer.kind !== "ready" || !answer.sessionHostRoot) throw new ServerError({ class: "internal", message: `Session ${sessionId} was reserved in its own host, which answered no connection` })
    relay.adopt(answer.link)
  }
}

function sessionRowHost(json: Transport["json"], account: HostedAccount | undefined): Transport["findSessionHost"] {
  return async (workspaceId, sessionId) => {
    const one = { sessionId, limit: 1, settled: "all", sort: SESSION_LIST_SORT }
    const page = account ? await account.run("session.activity.page", one) : await json(withQuery("/api/control/session-list", { scope: "all", ...one }))
    return sessionHostRootFromListItem(asArray(asRecordOrEmpty(page).items).find((item) => {
      const row = asRecordOrEmpty(item)
      return row.sessionId === sessionId && row.workspaceId === workspaceId
    }))
  }
}

export function createTransport(config: ServerConfig): Transport {
  const serverUrl = resolveServerUrl(config)
  const loopback = isLoopbackUrl(serverUrl)
  const request = (path: string, init?: RequestInit) => fetchFromServer(config, `${serverUrl}${path}`, init)
  const account = config.account ? createHostedAccount(config.account) : undefined
  const connections = createWorkspaceConnections(request, account)
  const hosts = sessionHostSignals()
  const outdated = imageOutdatedSignals()
  const read = async (workspaceId: string, sessionId?: string) => {
    try {
      return hosts.learned(workspaceId, sessionId, await connections.read(workspaceId, sessionId))
    } catch (error) {
      outdated.refused(workspaceId, error)
      throw error
    }
  }
  const relay = createRelay(read, config.relayLinks)
  const daemonProxy = loopback && config.account === undefined
  const runtime = (route: RuntimeRoute, path: string, init?: RequestInit) => {
    if (!route.remote) return request(withQuery(path, { directory: route.directory }), init)
    const session = sessionScope(route)
    if (daemonProxy && !session) return request(workspaceProxyPath(route, path), init)
    return relay.fetch(route.workspaceId, withoutRouteQuery(path), init, session)
  }
  const runtimeSocket = async (route: RuntimeRoute, path: string): Promise<WebSocket> => {
    if (!route.remote) return new WebSocket(socketUrl(serverUrl, withQuery(path, { directory: route.directory })))
    const session = sessionScope(route)
    if (daemonProxy && !session) return new WebSocket(socketUrl(serverUrl, workspaceProxyPath(route, path)))
    return relay.webSocket(route.workspaceId, withoutRouteQuery(path), session)
  }
  const label = (path: string, init?: RequestInit) => `${init?.method ?? "GET"} ${path}`
  const json: Transport["json"] = async (path, init) => readJsonResponse(await request(path, init), label(path, init))
  return {
    serverUrl,
    loopback,
    request,
    runtime,
    runtimeSocket,
    json,
    runtimeJson: async (route, path, init) => readJsonResponse(await runtime(route, path, init), label(path, init)),
    startRuntime: async (workspaceId, options) => {
      const link = await startWorkspace(connections.start, workspaceId, options)
      if (!daemonProxy) relay.adopt(link)
    },
    connectSession: sessionHostConnector(connections, relay, hosts),
    findSessionHost: daemonProxy ? async () => undefined : sessionRowHost(json, loopback ? account : undefined),
    onSessionHost: hosts.onSessionHost,
    onImageOutdated: outdated.onImageOutdated,
  }
}

export function jsonInit(method: "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown, init?: RequestInit): RequestInit {
  return { ...init, method, body: JSON.stringify(body ?? {}) }
}
