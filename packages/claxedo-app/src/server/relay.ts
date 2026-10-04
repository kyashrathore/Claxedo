import { asFiniteNumber, asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import { toAppError } from "./errors"
import { workspaceStopped, type RelayConnection, type WorkspaceConnections } from "./wire/connection"

export type Relay = {
  readonly fetch: (workspaceId: string, path: string, init?: RequestInit, sessionId?: string) => Promise<Response>
  readonly webSocket: (workspaceId: string, path: string, sessionId?: string) => Promise<WebSocket>
  readonly adopt: (link: RelayConnection) => void
}

export type RelayLinkStorage = { readonly scope: string; readonly storage: Pick<Storage, "getItem" | "setItem"> }

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

function usable(link: RelayConnection) {
  return link.tokenExpiresAt - Date.now() > REFRESH_WINDOW_MS
}

function storedLinks(links: RelayLinkStorage | undefined) {
  const name = (key: string) => `claxedo:relay-link:${links?.scope}:${key}`
  return {
    read: (key: string): RelayConnection | undefined => {
      const raw = links?.storage.getItem(name(key))
      if (!raw) return undefined
      const row = asRecordOrEmpty(JSON.parse(raw))
      const [workspaceId, relayUrl, runtimeAccessToken, tokenExpiresAt] = [asString(row.workspaceId), asString(row.relayUrl), asString(row.runtimeAccessToken), asFiniteNumber(row.tokenExpiresAt)]
      if (!workspaceId || !relayUrl || !runtimeAccessToken || tokenExpiresAt === undefined) return undefined
      const link: RelayConnection = { workspaceId, relayUrl, runtimeAccessToken, tokenExpiresAt, ...(asString(row.sessionId) ? { sessionId: asString(row.sessionId) } : {}) }
      return usable(link) ? link : undefined
    },
    write: (key: string, link: RelayConnection) => {
      try {
        links?.storage.setItem(name(key), JSON.stringify(link))
      } catch (error) {
        console.warn("A relay link could not be kept for the next reload", { workspaceId: link.workspaceId, error })
      }
    },
  }
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

function relayConnections(read: WorkspaceConnections["read"], links: RelayLinkStorage | undefined) {
  const connections = new Map<string, Promise<RelayConnection>>()
  const stored = storedLinks(links)
  const hold = async (key: string, pending: Promise<RelayConnection>) => {
    connections.set(key, pending)
    try {
      const link = await pending
      stored.write(key, link)
      return link
    } catch (error) {
      if (connections.get(key) === pending) connections.delete(key)
      throw error
    }
  }
  const key = (workspaceId: string, sessionId?: string) => JSON.stringify([workspaceId, sessionId ?? null])
  const kept = (at: string) => {
    const link = stored.read(at)
    if (link) connections.set(at, Promise.resolve(link))
    return link && connections.get(at)
  }
  const connection = (workspaceId: string, sessionId?: string, force = false) => {
    const at = key(workspaceId, sessionId)
    return (!force && (connections.get(at) ?? kept(at))) || hold(at, readConnection(read, workspaceId, sessionId))
  }
  const fresh = async (workspaceId: string, sessionId?: string) => {
    const current = await connection(workspaceId, sessionId)
    return usable(current) ? current : connection(workspaceId, sessionId, true)
  }
  const adopt = (link: RelayConnection) => {
    connections.set(key(link.workspaceId, link.sessionId), Promise.resolve(link))
    stored.write(key(link.workspaceId, link.sessionId), link)
  }
  return { connection, fresh, adopt }
}

export function createRelay(read: WorkspaceConnections["read"], links?: RelayLinkStorage): Relay {
  const { connection, fresh, adopt } = relayConnections(read, links)
  return {
    fetch: async (workspaceId, path, init, sessionId) => {
      const response = await sendThroughRelay(await fresh(workspaceId, sessionId), path, init)
      return response.status === 401 ? sendThroughRelay(await connection(workspaceId, sessionId, true), path, init) : response
    },
    webSocket: async (workspaceId, path, sessionId) => {
      const link = await fresh(workspaceId, sessionId)
      return new WebSocket(workspaceUrl(link, path).replace(/^http/, "ws"), [`${RUNTIME_ACCESS_TOKEN_PROTOCOL}${link.runtimeAccessToken}`])
    },
    adopt,
  }
}
