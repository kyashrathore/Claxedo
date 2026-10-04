import { workspaceRuntimeClientError } from "@claxedo/workspace-runtime/client"
import { asRecord } from "@claxedo/helpers/guards"
import type { ClaxedoFetch } from "./contract"
import { ClaxedoMcpClientError } from "./errors"

export type WorkspaceConnection = Readonly<{
  workspaceId: string
  relayUrl: string
  runtimeAccessToken: string
  /** Epoch milliseconds, as the control plane stamps it. */
  tokenExpiresAt: number
}>

export type WorkspaceConnectionOptions = Readonly<{
  controlPlane: ClaxedoFetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** A cached token this close to `tokenExpiresAt` is refreshed before use. */
  refreshWindowMs?: number
  provisioningMaxAttempts?: number
}>

export type WorkspaceConnectionCache = Readonly<{
  /** The cached connection while it is fresh; otherwise a refresh (or a first mint). */
  get(workspaceId: string): Promise<WorkspaceConnection>
  /** A new token whatever the cache holds; the previous token is revoked at the control plane. */
  refresh(workspaceId: string): Promise<WorkspaceConnection>
}>

const DEFAULT_REFRESH_WINDOW_MS = 60_000
const DEFAULT_PROVISIONING_MAX_ATTEMPTS = 30
const PROVISIONING_RETRY_MIN_MS = 500
const PROVISIONING_RETRY_MAX_MS = 30_000
const PROVISIONING_RETRY_DEFAULT_MS = 2_000

export function workspaceConnectionPath(workspaceId: string, action?: "refresh") {
  return `/api/workspace/${encodeURIComponent(workspaceId)}/connection${action ? `/${action}` : ""}`
}

export function relayRuntimeBaseUrl(connection: Pick<WorkspaceConnection, "relayUrl" | "workspaceId">) {
  return `${connection.relayUrl}/workspaces/${encodeURIComponent(connection.workspaceId)}`
}

export function createWorkspaceConnectionCache(options: WorkspaceConnectionOptions): WorkspaceConnectionCache {
  const now = options.now ?? Date.now
  const refreshWindowMs = options.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS
  const cached = new Map<string, WorkspaceConnection>()
  const pending = new Map<string, Promise<WorkspaceConnection>>()

  const fresh = (connection: WorkspaceConnection) => connection.tokenExpiresAt - now() > refreshWindowMs

  const settle = (workspaceId: string, work: () => Promise<WorkspaceConnection>) => {
    const inFlight = pending.get(workspaceId)
    if (inFlight) return inFlight
    const promise = work()
      .then((connection) => {
        cached.set(workspaceId, connection)
        return connection
      })
      .finally(() => pending.delete(workspaceId))
    pending.set(workspaceId, promise)
    return promise
  }

  const refresh = (workspaceId: string) =>
    settle(workspaceId, () => {
      const previous = cached.get(workspaceId)
      const previousJti = previous ? jtiClaim(previous.runtimeAccessToken) : undefined
      if (!previous) return handshake(workspaceId, options, undefined)
      return handshake(workspaceId, options, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(previousJti ? { previousJti } : {}),
      })
    })

  return {
    get(workspaceId) {
      const current = cached.get(workspaceId)
      if (current && fresh(current)) return Promise.resolve(current)
      return refresh(workspaceId)
    },
    refresh,
  }
}

// The first mint POSTs an empty body: minting can start billable compute
// server-side, so it is not a GET — `GET /connection` is the read-only status
// path (P-118).
const MINT_INIT: RequestInit = {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
}

async function handshake(workspaceId: string, options: WorkspaceConnectionOptions, refresh: RequestInit | undefined) {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const attempts = options.provisioningMaxAttempts ?? DEFAULT_PROVISIONING_MAX_ATTEMPTS
  const path = workspaceConnectionPath(workspaceId, refresh ? "refresh" : undefined)
  const operation = refresh ? "workspace.connection.refresh" : "workspace.connection"
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await options.controlPlane(path, refresh ?? MINT_INIT)
    if (!response.ok) throw await workspaceRuntimeClientError(operation, response)
    const body: unknown = await response.json()
    const row = asRecord(body)
    if (row?.status === "provisioning") {
      // `retryAfterMs` is server-controlled; a malformed or hostile value must
      // neither spin the loop nor park it for an hour.
      const retryAfterMs = row.retryAfterMs
      await sleep(
        typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)
          ? Math.min(PROVISIONING_RETRY_MAX_MS, Math.max(PROVISIONING_RETRY_MIN_MS, retryAfterMs))
          : PROVISIONING_RETRY_DEFAULT_MS,
      )
      continue
    }
    return connectionFromResponseBody(body)
  }
  throw new ClaxedoMcpClientError("connection-provisioning", `Workspace ${workspaceId} runtime is still provisioning`)
}

function connectionFromResponseBody(body: unknown): WorkspaceConnection {
  const row = asRecord(body)
  const workspaceId = row?.workspaceId
  const relayUrl = row?.relayUrl
  const runtimeAccessToken = row?.runtimeAccessToken
  const tokenExpiresAt = row?.tokenExpiresAt
  if (
    typeof workspaceId !== "string" ||
    typeof relayUrl !== "string" ||
    typeof runtimeAccessToken !== "string" ||
    typeof tokenExpiresAt !== "number"
  ) {
    throw new ClaxedoMcpClientError("connection-invalid", "Workspace connection response is missing relayUrl, runtimeAccessToken or tokenExpiresAt")
  }
  return { workspaceId, relayUrl: relayUrl.replace(/\/+$/, ""), runtimeAccessToken, tokenExpiresAt }
}

/** The `jti` of an unverified JWT: the control plane revokes the token by it on refresh. */
export function jtiClaim(token: string): string | undefined {
  const payload = token.split(".")[1]
  if (!payload) return undefined
  try {
    const text = payload.replaceAll("-", "+").replaceAll("_", "/")
    const parsed: unknown = JSON.parse(atob(text.padEnd(Math.ceil(text.length / 4) * 4, "=")))
    const jti = asRecord(parsed)?.jti
    return typeof jti === "string" && jti.length > 0 ? jti : undefined
  } catch {
    return undefined
  }
}
