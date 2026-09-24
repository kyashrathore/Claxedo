import { ServerError, responseError, toAppError } from "./errors"

export type RelayConnection = {
  readonly workspaceId: string
  readonly relayUrl: string
  readonly runtimeAccessToken: string
  readonly tokenExpiresAt: number
}

export type Relay = {
  readonly fetch: (workspaceId: string, path: string, init?: RequestInit) => Promise<Response>
  readonly webSocket: (workspaceId: string, path: string) => Promise<WebSocket>
}

const REFRESH_WINDOW_MS = 60_000
const RUNTIME_ACCESS_TOKEN_PROTOCOL = "claxedo-rat."

function tokenJti(token: string): string {
  const encoded = token.split(".")[1]
  if (!encoded) throw new ServerError({ class: "internal", message: "The runtime access token is not a JWT" })
  const text = encoded.replaceAll("-", "+").replaceAll("_", "/")
  const payload: unknown = JSON.parse(atob(text.padEnd(Math.ceil(text.length / 4) * 4, "=")))
  const jti = payload && typeof payload === "object" ? (payload as { jti?: unknown }).jti : undefined
  if (typeof jti !== "string") throw new ServerError({ class: "internal", message: "The runtime access token names no jti" })
  return jti
}

function parseConnection(body: unknown, workspaceId: string): RelayConnection {
  const row = body && typeof body === "object" ? (body as Record<string, unknown>) : undefined
  const relayUrl = row?.relayUrl
  const token = row?.runtimeAccessToken
  const expiresAt = row?.tokenExpiresAt
  if (typeof relayUrl !== "string" || typeof token !== "string" || typeof expiresAt !== "number") {
    throw new ServerError({ class: "internal", message: `The workspace connection for ${workspaceId} is malformed` })
  }
  return { workspaceId, relayUrl: relayUrl.replace(/\/+$/, ""), runtimeAccessToken: token, tokenExpiresAt: expiresAt }
}

function workspaceUrl(link: RelayConnection, path: string) {
  return `${link.relayUrl}/workspaces/${encodeURIComponent(link.workspaceId)}${path}`
}

type Request = (path: string, init?: RequestInit) => Promise<Response>

async function mint(request: Request, workspaceId: string, previous?: RelayConnection): Promise<RelayConnection> {
  const suffix = previous ? "/connection/refresh" : "/connection"
  const response = await request(`/api/workspace/${encodeURIComponent(workspaceId)}${suffix}`, {
    method: "POST",
    body: JSON.stringify(previous ? { previousJti: tokenJti(previous.runtimeAccessToken) } : {}),
  })
  if (!response.ok) throw await responseError(response, "Workspace connection")
  return parseConnection(await response.json(), workspaceId)
}

async function send(link: RelayConnection, path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set("Authorization", `Bearer ${link.runtimeAccessToken}`)
  if (typeof init?.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  try {
    return await fetch(workspaceUrl(link, path), { ...init, headers, credentials: "omit", redirect: init?.redirect ?? "manual" })
  } catch (error) {
    throw toAppError(error)
  }
}

export function createRelay(request: Request): Relay {
  const connections = new Map<string, Promise<RelayConnection>>()
  const hold = async (workspaceId: string, pending: Promise<RelayConnection>) => {
    connections.set(workspaceId, pending)
    try {
      return await pending
    } catch (error) {
      if (connections.get(workspaceId) === pending) connections.delete(workspaceId)
      throw error
    }
  }
  const connection = (workspaceId: string, force = false) => (!force && connections.get(workspaceId)) || hold(workspaceId, mint(request, workspaceId))
  const fresh = async (workspaceId: string) => {
    const current = await connection(workspaceId)
    return current.tokenExpiresAt - Date.now() > REFRESH_WINDOW_MS ? current : hold(workspaceId, mint(request, workspaceId, current))
  }
  return {
    fetch: async (workspaceId, path, init) => {
      const response = await send(await fresh(workspaceId), path, init)
      return response.status === 401 ? send(await connection(workspaceId, true), path, init) : response
    },
    webSocket: async (workspaceId, path) => {
      const link = await fresh(workspaceId)
      return new WebSocket(workspaceUrl(link, path).replace(/^http/, "ws"), [`${RUNTIME_ACCESS_TOKEN_PROTOCOL}${link.runtimeAccessToken}`])
    },
  }
}
