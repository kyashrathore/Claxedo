import { startWorkspace } from "./workspace-start"
import { responseError, toAppError } from "./errors"
import { connectionAnswerFromWire, workspaceStopped, type RelayConnection } from "./wire/connection"

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

type Request = (path: string, init?: RequestInit) => Promise<Response>

async function readRelayConnection(request: Request, workspaceId: string): Promise<RelayConnection> {
  const response = await request(`/api/workspace/${encodeURIComponent(workspaceId)}/connection`)
  if (!response.ok) throw await responseError(response, "Workspace connection")
  const answer = connectionAnswerFromWire(await response.json(), workspaceId)
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
  const connection = (workspaceId: string, force = false) => (!force && connections.get(workspaceId)) || hold(workspaceId, readRelayConnection(request, workspaceId))
  const fresh = async (workspaceId: string) => {
    const current = await connection(workspaceId)
    return current.tokenExpiresAt - Date.now() > REFRESH_WINDOW_MS ? current : connection(workspaceId, true)
  }
  return {
    fetch: async (workspaceId, path, init) => {
      const response = await sendThroughRelay(await fresh(workspaceId), path, init)
      return response.status === 401 ? sendThroughRelay(await hold(workspaceId, startWorkspace(request, workspaceId)), path, init) : response
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
