import { asArray, asFiniteNumber, asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import { isHopErrorPage, toAppError, unansweredRuntime } from "./errors"
import { workspaceStopped, type RelayConnection, type WorkspaceConnections } from "./wire/connection"

export type Relay = {
  readonly fetch: (workspaceId: string, path: string, init?: RequestInit, sessionId?: string) => Promise<Response>
  readonly webSocket: (workspaceId: string, path: string, sessionId?: string) => Promise<WebSocket>
  readonly adopt: (link: RelayConnection) => void
}

export type RelayLinkSiblings = Pick<BroadcastChannel, "postMessage" | "onmessage">

export type RelayLinkStorage = {
  readonly scope: string
  readonly storage: Pick<Storage, "getItem" | "setItem">
  readonly siblings?: RelayLinkSiblings
}

const REFRESH_WINDOW_MS = 60_000
const RUNTIME_ACCESS_TOKEN_PROTOCOL = "claxedo-rat."

function workspaceUrl(link: RelayConnection, path: string) {
  const url = `${link.relayUrl}/workspaces/${encodeURIComponent(link.workspaceId)}${path}`
  return link.region ? `${url}${path.includes("?") ? "&" : "?"}region=${encodeURIComponent(link.region)}` : url
}

async function readConnection(read: WorkspaceConnections["read"], workspaceId: string, sessionId?: string): Promise<RelayConnection> {
  const answer = await read(workspaceId, sessionId)
  if (answer.kind !== "ready") throw workspaceStopped()
  return answer.link
}

function usable(link: RelayConnection) {
  return link.tokenExpiresAt - Date.now() > REFRESH_WINDOW_MS
}

function linkFrom(value: unknown): RelayConnection | undefined {
  const row = asRecordOrEmpty(value)
  const [workspaceId, relayUrl, runtimeAccessToken, tokenExpiresAt] = [asString(row.workspaceId), asString(row.relayUrl), asString(row.runtimeAccessToken), asFiniteNumber(row.tokenExpiresAt)]
  if (!workspaceId || !relayUrl || !runtimeAccessToken || tokenExpiresAt === undefined) return undefined
  const [sessionId, region] = [asString(row.sessionId), asString(row.region)]
  const link: RelayConnection = { workspaceId, relayUrl, runtimeAccessToken, tokenExpiresAt, ...(sessionId ? { sessionId } : {}), ...(region ? { region } : {}) }
  return usable(link) ? link : undefined
}

function storedLinks(links: RelayLinkStorage | undefined) {
  const name = (key: string) => `claxedo:relay-link:${links?.scope}:${key}`
  return {
    read: (key: string): RelayConnection | undefined => {
      const raw = links?.storage.getItem(name(key))
      return raw ? linkFrom(JSON.parse(raw)) : undefined
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
  let response: Response
  try {
    response = await fetch(workspaceUrl(link, path), { ...init, headers, credentials: "omit", redirect: init?.redirect ?? "manual" })
  } catch (error) {
    throw toAppError(error)
  }
  if (!isHopErrorPage(response)) return response
  void response.body?.cancel()
  throw unansweredRuntime(response)
}

const key = (workspaceId: string, sessionId?: string) => JSON.stringify([workspaceId, sessionId ?? null])

function heldLinks(links: RelayLinkStorage | undefined) {
  const held = new Map<string, RelayConnection>()
  const stored = storedLinks(links)
  const siblings = links?.siblings
  const settle = (at: string, link: RelayConnection, announce: boolean) => {
    held.set(at, link)
    stored.write(at, link)
    if (announce) siblings?.postMessage({ links: [link] })
    return link
  }
  const offered = (link: RelayConnection) => {
    const current = held.get(key(link.workspaceId, link.sessionId))
    return !(current && usable(current) && current.tokenExpiresAt >= link.tokenExpiresAt)
  }
  if (siblings) {
    siblings.onmessage = (event) => {
      const message = asRecordOrEmpty(event.data)
      if (message.ask === true) siblings.postMessage({ links: [...held.values()].filter(usable) })
      for (const link of asArray(message.links).map(linkFrom)) if (link && offered(link)) settle(key(link.workspaceId, link.sessionId), link, false)
    }
    siblings.postMessage({ ask: true })
  }
  return {
    kept: (at: string) => {
      const current = held.get(at)
      if (current && usable(current)) return current
      const link = stored.read(at)
      return link ? settle(at, link, false) : undefined
    },
    settle,
  }
}

function relayConnections(read: WorkspaceConnections["read"], links: RelayLinkStorage | undefined) {
  const minting = new Map<string, Promise<RelayConnection>>()
  const { kept, settle } = heldLinks(links)
  const mint = async (at: string, workspaceId: string, sessionId?: string) => {
    const pending = readConnection(read, workspaceId, sessionId)
    minting.set(at, pending)
    try {
      return settle(at, await pending, true)
    } finally {
      if (minting.get(at) === pending) minting.delete(at)
    }
  }
  return {
    connection: (workspaceId: string, sessionId?: string, force = false) => {
      const at = key(workspaceId, sessionId)
      return minting.get(at) ?? (force ? undefined : kept(at)) ?? mint(at, workspaceId, sessionId)
    },
    adopt: (link: RelayConnection) => void settle(key(link.workspaceId, link.sessionId), link, true),
  }
}

export function createRelay(read: WorkspaceConnections["read"], links?: RelayLinkStorage): Relay {
  const { connection, adopt } = relayConnections(read, links)
  return {
    fetch: async (workspaceId, path, init, sessionId) => {
      const response = await sendThroughRelay(await connection(workspaceId, sessionId), path, init)
      return response.status === 401 ? sendThroughRelay(await connection(workspaceId, sessionId, true), path, init) : response
    },
    webSocket: async (workspaceId, path, sessionId) => {
      const link = await connection(workspaceId, sessionId)
      return new WebSocket(workspaceUrl(link, path).replace(/^http/, "ws"), [`${RUNTIME_ACCESS_TOKEN_PROTOCOL}${link.runtimeAccessToken}`])
    },
    adopt,
  }
}
