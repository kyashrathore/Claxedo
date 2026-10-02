import { toAppError } from "./errors"
import { workspaceStopped, type RelayConnection, type WorkspaceConnections } from "./wire/connection"

export type Relay = {
  readonly fetch: (workspaceId: string, path: string, init?: RequestInit) => Promise<Response>
  readonly webSocket: (workspaceId: string, path: string) => Promise<WebSocket>
  readonly adopt: (link: RelayConnection) => void
}

const REFRESH_WINDOW_MS = 60_000
const RUNTIME_ACCESS_TOKEN_PROTOCOL = "claxedo-rat."

function workspaceUrl(link: RelayConnection, path: string) {
  return `${link.relayUrl}/workspaces/${encodeURIComponent(link.workspaceId)}${path}`
}

async function readConnection(read: WorkspaceConnections["read"], workspaceId: string): Promise<RelayConnection> {
  const answer = await read(workspaceId)
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
  const connection = (workspaceId: string, force = false) => (!force && connections.get(workspaceId)) || hold(workspaceId, readConnection(read, workspaceId))
  const fresh = async (workspaceId: string) => {
    const current = await connection(workspaceId)
    return current.tokenExpiresAt - Date.now() > REFRESH_WINDOW_MS ? current : connection(workspaceId, true)
  }
  return {
    fetch: async (workspaceId, path, init) => {
      const response = await sendThroughRelay(await fresh(workspaceId), path, init)
      return response.status === 401 ? sendThroughRelay(await connection(workspaceId, true), path, init) : response
    },
    webSocket: async (workspaceId, path) => {
      const link = await fresh(workspaceId)
      return new WebSocket(workspaceUrl(link, path).replace(/^http/, "ws"), [`${RUNTIME_ACCESS_TOKEN_PROTOCOL}${link.runtimeAccessToken}`])
    },
    adopt: (link) => {
      connections.set(link.workspaceId, Promise.resolve(link))
    },
  }
}
