import { ServerError, responseError, toAppError } from "./errors"

export type RelayConnection = {
  readonly workspaceId: string
  readonly relayUrl: string
  readonly runtimeAccessToken: string
  readonly tokenExpiresAt: number
}

export type Relay = {
  readonly fetch: (workspaceId: string, path: string, init?: RequestInit) => Promise<Response>
  readonly forget: (workspaceId: string) => void
}

const REFRESH_WINDOW_MS = 60_000

function tokenJti(token: string): string | undefined {
  const encoded = token.split(".")[1]
  if (!encoded) return undefined
  const text = encoded.replaceAll("-", "+").replaceAll("_", "/")
  try {
    const payload: unknown = JSON.parse(atob(text.padEnd(Math.ceil(text.length / 4) * 4, "=")))
    const jti = payload && typeof payload === "object" ? (payload as { jti?: unknown }).jti : undefined
    return typeof jti === "string" ? jti : undefined
  } catch {
    return undefined
  }
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

export function createRelay(input: {
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly serverUrl: string
}): Relay {
  const connections = new Map<string, Promise<RelayConnection>>()

  const mint = async (workspaceId: string, previous?: RelayConnection): Promise<RelayConnection> => {
    const suffix = previous ? "/connection/refresh" : "/connection"
    const previousJti = previous ? tokenJti(previous.runtimeAccessToken) : undefined
    const response = await input.request(`/api/workspace/${encodeURIComponent(workspaceId)}${suffix}`, {
      method: "POST",
      body: JSON.stringify(previousJti ? { previousJti } : {}),
    })
    if (!response.ok) throw await responseError(response, "Workspace connection")
    return parseConnection(await response.json(), workspaceId)
  }

  const connection = (workspaceId: string, force = false) => {
    const cached = force ? undefined : connections.get(workspaceId)
    if (cached) return cached
    const pending = mint(workspaceId)
    connections.set(workspaceId, pending)
    pending.catch(() => connections.delete(workspaceId))
    return pending
  }

  const fresh = async (workspaceId: string) => {
    const current = await connection(workspaceId)
    if (current.tokenExpiresAt - Date.now() > REFRESH_WINDOW_MS) return current
    const refreshed = mint(workspaceId, current)
    connections.set(workspaceId, refreshed)
    refreshed.catch(() => connections.delete(workspaceId))
    return refreshed
  }

  const send = async (link: RelayConnection, path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${link.runtimeAccessToken}`)
    if (typeof init?.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json")
    try {
      return await fetch(`${link.relayUrl}/workspaces/${encodeURIComponent(link.workspaceId)}${path}`, {
        ...init,
        headers,
        credentials: "omit",
        redirect: init?.redirect ?? "manual",
      })
    } catch (error) {
      throw toAppError(error)
    }
  }

  return {
    fetch: async (workspaceId, path, init) => {
      const response = await send(await fresh(workspaceId), path, init)
      if (response.status !== 401) return response
      return send(await connection(workspaceId, true), path, init)
    },
    forget: (workspaceId) => {
      connections.delete(workspaceId)
    },
  }
}
