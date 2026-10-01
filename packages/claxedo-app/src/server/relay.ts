import { toAppError } from "./errors"
import { workspaceStopped, type RelayConnection, type WorkspaceConnections } from "./wire/connection"

export type Relay = {
  readonly fetch: (workspaceId: string, path: string, init?: RequestInit) => Promise<Response>
  readonly webSocket: (workspaceId: string, path: string) => Promise<WebSocket>
  readonly adopt: (link: RelayConnection) => void
}

const RUNTIME_ACCESS_TOKEN_PROTOCOL = "claxedo-rat."
const MAX_CONNECTIONS = 128
const REFRESH_WINDOW_MS = 60_000

function workspaceUrl(link: RelayConnection, path: string) {
  return `${link.relayUrl}/workspaces/${encodeURIComponent(link.workspaceId)}${path}`
}

async function sendThroughRelay(link: RelayConnection, path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  headers.set("Authorization", `Bearer ${link.runtimeAccessToken}`)
  if (typeof init?.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  try {
    return await fetch(workspaceUrl(link, path), { ...init, headers, credentials: "omit", redirect: init?.redirect ?? "manual" })
  } catch (error) {
    throw toAppError(error)
  }
}

function sessionScope(path: string): string | undefined {
  const url = new URL(path, "http://route.local")
  const session = url.pathname.match(/^\/session\/([^/]+)/)?.[1]
  return session ? decodeURIComponent(session) : url.searchParams.get("sessionID") ?? url.searchParams.get("sessionId") ?? undefined
}

async function readConnection(read: WorkspaceConnections["read"], workspaceId: string, sessionId?: string): Promise<RelayConnection> {
  const answer = await read(workspaceId, sessionId)
  if (answer.kind !== "ready") throw workspaceStopped(workspaceId)
  return answer.link
}

function createRelayConnections(read: WorkspaceConnections["read"]) {
  const connections = new Map<string, Promise<RelayConnection>>()
  const put = (key: string, pending: Promise<RelayConnection>) => {
    connections.delete(key)
    connections.set(key, pending)
    if (connections.size > MAX_CONNECTIONS) connections.delete(connections.keys().next().value!)
    return pending
  }
  const hold = async (key: string, pending: Promise<RelayConnection>) => {
    put(key, pending)
    try {
      return await pending
    } catch (error) {
      if (connections.get(key) === pending) connections.delete(key)
      throw error
    }
  }
  const connection = (workspaceId: string, sessionId: string | undefined, force = false) => {
    const key = JSON.stringify([workspaceId, sessionId])
    const cached = !force && connections.get(key)
    return cached ? put(key, cached) : hold(key, readConnection(read, workspaceId, sessionId))
  }
  return {
    renew: (workspaceId: string, sessionId?: string) => connection(workspaceId, sessionId, true),
    fresh: async (workspaceId: string, sessionId?: string) => {
      const current = await connection(workspaceId, sessionId)
      return current.tokenExpiresAt - Date.now() > REFRESH_WINDOW_MS ? current : connection(workspaceId, sessionId, true)
    },
    adopt: (link: RelayConnection) => { put(JSON.stringify([link.workspaceId, undefined]), Promise.resolve(link)) },
  }
}

export function createRelay(read: WorkspaceConnections["read"]): Relay {
  const connections = createRelayConnections(read)
  return {
    fetch: async (workspaceId, path, init) => {
      const sessionId = sessionScope(path)
      const response = await sendThroughRelay(await connections.fresh(workspaceId, sessionId), path, init)
      return response.status === 401 ? sendThroughRelay(await connections.renew(workspaceId, sessionId), path, init) : response
    },
    webSocket: async (workspaceId, path) => {
      const link = await connections.fresh(workspaceId, sessionScope(path))
      return new WebSocket(workspaceUrl(link, path).replace(/^http/, "ws"), [`${RUNTIME_ACCESS_TOKEN_PROTOCOL}${link.runtimeAccessToken}`])
    },
    adopt: connections.adopt,
  }
}
