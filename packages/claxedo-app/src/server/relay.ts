import { toAppError } from "./errors"
import { workspaceStopped, type RelayConnection, type WorkspaceConnections } from "./wire/connection"

export type Relay = {
  readonly fetch: (workspaceId: string, path: string, init?: RequestInit, sessionId?: string) => Promise<Response>
  readonly webSocket: (workspaceId: string, path: string, sessionId?: string) => Promise<WebSocket>
  readonly adopt: (link: RelayConnection) => void
}

const REFRESH_WINDOW_MS = 60_000
const RUNTIME_ACCESS_TOKEN_PROTOCOL = "claxedo-rat."

function workspaceUrl(link: RelayConnection, path: string) {
  return `${link.relayUrl}/workspaces/${encodeURIComponent(link.workspaceId)}${path}`
}

async function readConnection(read: WorkspaceConnections["read"], workspaceId: string, sessionId?: string): Promise<RelayConnection> {
  const answer = await read(workspaceId, sessionId)
  if (answer.kind !== "ready") throw workspaceStopped(workspaceId)
  return answer.link
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

export function createRelay(read: WorkspaceConnections["read"]): Relay {
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
  const key = (workspaceId: string, sessionId?: string) => JSON.stringify([workspaceId, sessionId ?? null])
  const connection = (workspaceId: string, sessionId?: string, force = false) => (!force && connections.get(key(workspaceId, sessionId))) || hold(key(workspaceId, sessionId), readConnection(read, workspaceId, sessionId))
  const fresh = async (workspaceId: string, sessionId?: string) => {
    const current = await connection(workspaceId, sessionId)
    return current.tokenExpiresAt - Date.now() > REFRESH_WINDOW_MS ? current : connection(workspaceId, sessionId, true)
  }
  return {
    fetch: async (workspaceId, path, init, sessionId) => {
      const response = await sendThroughRelay(await fresh(workspaceId, sessionId), path, init)
      return response.status === 401 ? sendThroughRelay(await connection(workspaceId, sessionId, true), path, init) : response
    },
    webSocket: async (workspaceId, path, sessionId) => {
      const link = await fresh(workspaceId, sessionId)
      return new WebSocket(workspaceUrl(link, path).replace(/^http/, "ws"), [`${RUNTIME_ACCESS_TOKEN_PROTOCOL}${link.runtimeAccessToken}`])
    },
    adopt: (link) => {
      connections.set(key(link.workspaceId, link.sessionId), Promise.resolve(link))
    },
  }
}
