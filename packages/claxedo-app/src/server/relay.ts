import { asArray, asFiniteNumber, asRecordOrEmpty, asString } from "@claxedo/helpers/guards"
import { isHopErrorPage, toAppError, unansweredRuntime } from "./errors"
import { workspaceStopped, type RelayConnection, type WorkspaceConnections } from "./wire/connection"

export type Relay = {
  readonly fetch: (workspaceId: string, path: string, init?: RequestInit, sessionId?: string) => Promise<Response>
  readonly webSocket: (workspaceId: string, path: string, sessionId?: string) => Promise<WebSocket>
  readonly preload: (workspaceId: string, path: string, sessionId?: string) => boolean
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

function workspaceUrl(link: RelayConnection, path: string, relayUrl: string | undefined) {
  const url = `${relayUrl ?? link.relayUrl}/workspaces/${encodeURIComponent(link.workspaceId)}${path}`
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

async function sendThroughRelay(link: RelayConnection, path: string, init: RequestInit | undefined, relayUrl: string | undefined) {
  const headers = new Headers(init?.headers)
  headers.set("Authorization", `Bearer ${link.runtimeAccessToken}`)
  if (typeof init?.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
  let response: Response
  try {
    response = await fetch(workspaceUrl(link, path, relayUrl), { ...init, headers, credentials: "omit", redirect: init?.redirect ?? "manual" })
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
    held: (workspaceId: string, sessionId?: string) => (minting.has(key(workspaceId, sessionId)) ? undefined : kept(key(workspaceId, sessionId))),
    adopt: (link: RelayConnection) => void settle(key(link.workspaceId, link.sessionId), link, true),
  }
}

function isPlainGet(init: RequestInit | undefined) {
  return init === undefined || ((init.method === undefined || init.method.toUpperCase() === "GET") && init.body === undefined && init.headers === undefined)
}

function preloads(relayUrl: string | undefined) {
  const parked = new Map<string, Promise<Response>>()
  const name = (at: string, path: string) => `${at}\u0000${path}`
  return {
    start: (at: string, link: RelayConnection, path: string) => {
      const under = name(at, path)
      if (parked.has(under)) return
      const sent = sendThroughRelay(link, path, undefined, relayUrl)
      parked.set(under, sent)
      sent.catch((error: unknown) => {
        if (parked.get(under) !== sent) return
        parked.delete(under)
        console.warn("A preloaded runtime read failed before its reader asked, so the reader sends its own", { workspaceId: link.workspaceId, path, error })
      })
    },
    take: (at: string, path: string, init: RequestInit | undefined) => {
      if (!isPlainGet(init)) return undefined
      const under = name(at, path)
      const sent = parked.get(under)
      parked.delete(under)
      return sent
    },
  }
}

export function createRelay(read: WorkspaceConnections["read"], links?: RelayLinkStorage, relayUrl?: string): Relay {
  const { connection, held, adopt } = relayConnections(read, links)
  const ahead = preloads(relayUrl)
  return {
    fetch: async (workspaceId, path, init, sessionId) => {
      const response = await (ahead.take(key(workspaceId, sessionId), path, init) ?? sendThroughRelay(await connection(workspaceId, sessionId), path, init, relayUrl))
      return response.status === 401 ? sendThroughRelay(await connection(workspaceId, sessionId, true), path, init, relayUrl) : response
    },
    preload: (workspaceId, path, sessionId) => {
      const scoped = sessionId === undefined ? undefined : held(workspaceId, sessionId)
      const link = scoped ?? held(workspaceId)
      if (!link) return false
      ahead.start(scoped ? key(workspaceId, sessionId) : key(workspaceId), link, path)
      return true
    },
    webSocket: async (workspaceId, path, sessionId) => {
      const link = await connection(workspaceId, sessionId)
      return new WebSocket(workspaceUrl(link, path, relayUrl).replace(/^http/, "ws"), [`${RUNTIME_ACCESS_TOKEN_PROTOCOL}${link.runtimeAccessToken}`])
    },
    adopt,
  }
}
