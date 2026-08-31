import { apiBearerToken, getClaxedoServerUrl, authFetch, normalizeUrl } from "@/platform/api/api"
import { accountRun } from "@/platform/account/hosted-control-call"
import { decodeHostedResult } from "@/platform/account/hosted-operations"
import { queryClient } from "@/platform/query/query-client"

export type WorkspaceConnectionObserver = {
  onConnected: (info: WorkspaceConnectionInfo) => void
  onFailed: (workspaceId: string) => void
  /**
   * A provisioning poll answered with what the sandbox manager is actually
   * doing — `restore` (booting from the workspace's snapshot), `resume`
   * (restarting the paused resource), or `cold-start`. Lets the connect UI say
   * so instead of a generic spinner. Optional and best-effort: older servers
   * omit `bootMode` and the poll behaves as before.
   */
  onProvisioning?: (workspaceId: string, bootMode: WorkspaceBootMode | undefined) => void
}

export type WorkspaceBootMode = "restore" | "resume" | "cold-start"

function provisioningBootMode(input: { bootMode?: unknown }): WorkspaceBootMode | undefined {
  return input.bootMode === "restore" || input.bootMode === "resume" || input.bootMode === "cold-start"
    ? input.bootMode
    : undefined
}

let observer: WorkspaceConnectionObserver | undefined

export function setWorkspaceConnectionObserver(next: WorkspaceConnectionObserver | undefined) {
  observer = next
}

// Inlined from the deleted `runtime/workspace-relay-urls.ts` (rubric D6).
// Both functions are tiny URL builders used only here and inside
// `RuntimeGateway`; RuntimeGateway keeps its own copy to avoid a circular
// import with this file. Changing the URL shape means editing both call
// sites — that's tracked by `workspace-runtime-route-audit.test.ts`, which
// pins every owner of `/api/workspace/:id/connection*`.
function normalizedServerUrl(serverUrl: string | undefined) {
  return normalizeUrl(serverUrl) ?? getClaxedoServerUrl()
}

function workspaceConnectionUrl(input: { serverUrl?: string; workspaceId: string }) {
  return new URL(
    `/api/workspace/${encodeURIComponent(input.workspaceId)}/connection`,
    normalizedServerUrl(input.serverUrl),
  )
}

function workspaceConnectionRefreshUrl(input: { serverUrl?: string; workspaceId: string }) {
  return new URL(
    `/api/workspace/${encodeURIComponent(input.workspaceId)}/connection/refresh`,
    normalizedServerUrl(input.serverUrl),
  )
}

export type WorkspaceConnectionInfo = {
  access: "cloud" | "user-hosted"
  backing: "local-worktree" | "cloud-vm"
  runtimeKind?: "cloud" | "user-hosted"
  workspaceId: string
  homeRegion?: string
  role: RuntimeAccessTokenRole
  relayUrl: string
  directRuntimeUrl?: string
  runtimeAccessToken: string
  tokenExpiresAt: number
}

export type RuntimeAccessTokenRole = "owner" | "admin" | "editor" | "viewer"

type Options = {
  serverUrl?: string
  request?: typeof fetch
  relayRequest?: typeof fetch
  webSocket?: typeof WebSocket
  headers?: HeadersInit
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  refreshWindowMs?: number
  provisioningMaxAttempts?: number
}

const normalized = normalizeUrl
const DEFAULT_PROVISIONING_MAX_ATTEMPTS = 30
const PROVISIONING_RETRY_MIN_MS = 500
const PROVISIONING_RETRY_MAX_MS = 30_000
const PROVISIONING_RETRY_DEFAULT_MS = 2_000

function isProvisioning(input: unknown): input is { status: "provisioning"; retryAfterMs?: number; bootMode?: unknown } {
  return !!input
    && typeof input === "object"
    && !Array.isArray(input)
    && "status" in input
    && input.status === "provisioning"
}

// `retryAfterMs` is server-controlled — validate and clamp so a malformed or
// hostile value cannot spin immediate-fire polls (NaN/0/negative) or hang the
// cached bootstrap promise for hours (huge values).
function provisioningRetryDelay(retryAfterMs: unknown) {
  if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs)) return PROVISIONING_RETRY_DEFAULT_MS
  return Math.min(PROVISIONING_RETRY_MAX_MS, Math.max(PROVISIONING_RETRY_MIN_MS, retryAfterMs))
}

// Client-side defense for a 429 hitting the connection mint mid-provisioning:
// when the response carries a retry signal (body `error.retryAfterMs` or a
// `Retry-After` header), treat it as a provisioning-equivalent wait instead of
// failing the whole bootstrap.
function rateLimitRetryDelay(res: Response, body: unknown): number | undefined {
  const error = !!body && typeof body === "object" && "error" in body ? body.error : undefined
  if (!!error && typeof error === "object" && "retryAfterMs" in error && typeof error.retryAfterMs === "number") {
    return provisioningRetryDelay(error.retryAfterMs)
  }
  const header = res.headers.get("Retry-After")
  if (header && /^\d+$/.test(header.trim())) return provisioningRetryDelay(Number(header.trim()) * 1_000)
  return undefined
}

function parseConnection(input: unknown): WorkspaceConnectionInfo {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid workspace connection response")
  if (!("access" in input) || (input.access !== "cloud" && input.access !== "user-hosted")) throw new Error("Invalid workspace connection access")
  if (!("backing" in input) || (input.backing !== "local-worktree" && input.backing !== "cloud-vm")) throw new Error("Invalid workspace connection backing")
  if (!("workspaceId" in input) || typeof input.workspaceId !== "string") throw new Error("Invalid workspace connection workspaceId")
  if (!("role" in input) || !isRuntimeAccessTokenRole(input.role)) throw new Error("Invalid workspace connection role")
  if (!("relayUrl" in input) || typeof input.relayUrl !== "string") throw new Error("Invalid workspace connection relayUrl")
  const directRuntimeUrl = "directRuntimeUrl" in input && typeof input.directRuntimeUrl === "string"
    ? normalized(input.directRuntimeUrl) ?? input.directRuntimeUrl
    : undefined
  const runtimeKind = "runtimeKind" in input && (input.runtimeKind === "cloud" || input.runtimeKind === "user-hosted")
    ? input.runtimeKind
    : undefined
  const homeRegion = "homeRegion" in input && typeof input.homeRegion === "string" ? input.homeRegion : undefined
  if (!("runtimeAccessToken" in input) || typeof input.runtimeAccessToken !== "string") throw new Error("Invalid workspace connection token")
  if (!("tokenExpiresAt" in input) || typeof input.tokenExpiresAt !== "number") throw new Error("Invalid workspace connection expiry")
  return {
    access: input.access,
    backing: input.backing,
    ...(runtimeKind ? { runtimeKind } : {}),
    workspaceId: input.workspaceId,
    ...(homeRegion ? { homeRegion } : {}),
    role: input.role,
    relayUrl: normalized(input.relayUrl) ?? input.relayUrl,
    ...(directRuntimeUrl ? { directRuntimeUrl } : {}),
    runtimeAccessToken: input.runtimeAccessToken,
    tokenExpiresAt: input.tokenExpiresAt,
  }
}

function isRuntimeAccessTokenRole(input: unknown): input is RuntimeAccessTokenRole {
  return input === "owner" || input === "admin" || input === "editor" || input === "viewer"
}

function decodeBase64Url(input: string) {
  const text = input.replaceAll("-", "+").replaceAll("_", "/")
  return atob(text.padEnd(Math.ceil(text.length / 4) * 4, "="))
}

export function runtimeAccessTokenJti(token: string) {
  try {
    const payload: unknown = JSON.parse(decodeBase64Url(token.split(".")[1] ?? ""))
    if (!payload || typeof payload !== "object" || !("jti" in payload)) return undefined
    return typeof payload.jti === "string" ? payload.jti : undefined
  } catch {
    return undefined
  }
}

export function runtimeAccessTokenRole(token: string): RuntimeAccessTokenRole | undefined {
  try {
    const payload: unknown = JSON.parse(decodeBase64Url(token.split(".")[1] ?? ""))
    if (!payload || typeof payload !== "object" || !("role" in payload)) return undefined
    return isRuntimeAccessTokenRole(payload.role)
      ? payload.role
      : undefined
  } catch {
    return undefined
  }
}

export function runtimeAccessTokenProtocol(token: string) {
  return `claxedo-rat.${token}`
}

async function responseJson(res: Response) {
  const body = await res.json().catch(() => undefined)
  if (res.status === 429 || res.status === 409) {
    const retryAfterMs = rateLimitRetryDelay(res, body)
    if (retryAfterMs !== undefined) return { status: "rate-limited", retryAfterMs } as const
  }
  if (!res.ok) throw new Error(`Workspace connection failed: ${res.status}`)
  return body
}

function isRateLimited(input: unknown): input is { status: "rate-limited"; retryAfterMs: number } {
  return !!input
    && typeof input === "object"
    && "status" in input
    && input.status === "rate-limited"
}

function controlPlaneInit(options: Options, init?: RequestInit) {
  const headers = new Headers(init?.headers)
  new Headers(options.headers).forEach((value, key) => headers.set(key, value))
  return {
    ...init,
    headers,
  }
}

function sleep(options: Options, ms: number) {
  if (options.sleep) return options.sleep(ms)
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms))
}

function connectionCacheParts(workspaceId: string, options: Options) {
  const headers = new Headers(options.headers)
  return [
    normalizedServerUrl(options.serverUrl),
    workspaceId,
    headers.get("authorization") ?? "",
  ] as const
}

function connectionCacheKey(workspaceId: string, options: Options) {
  return ["shell", "workspace-connection", ...connectionCacheParts(workspaceId, options)] as const
}

async function connectionOptions(options: Options) {
  const headers = new Headers(options.headers)
  if (!headers.has("authorization")) {
    const token = await apiBearerToken()
    if (token) headers.set("Authorization", `Bearer ${token}`)
  }
  return { ...options, headers }
}

// Circuit-breaker cooldowns. The shell mounts one session pane per open tab,
// and each pane independently opens a workspace connection — so a layout with
// N stale tabs across dead/forbidden workspaces fans out into N connection
// mints. Evicting the cache the instant a mint fails (the old behaviour) let
// every pane re-fire immediately, producing a 403/409/429 flood that both
// looks broken and *causes* the 429 (the control plane rate-limits the very
// frequency we generate). Instead we keep the rejected promise cached for a
// cooldown so repeated callers reuse the failure without touching the network:
// at most one mint per workspace per cooldown window.
//
//   - Terminal (the workspace will not become reachable by retrying):
//     403 forbidden (not your workspace / host unregistered), 404, 409
//     conflict (no active host link), and 401 only when an explicit auth header
//     was supplied. Long cooldown.
//   - Transient (a retry might succeed once the host/runtime comes online):
//     unauthenticated startup 401s, 429 exhausted, 5xx, network/abort,
//     provisioning-timeout. Short/no cooldown.
const TERMINAL_FAILURE_COOLDOWN_MS = 60_000
const TRANSIENT_FAILURE_COOLDOWN_MS = 5_000

function connectionFailureStatus(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  return Number(
    /Workspace connection failed: (\d+)/.exec(message)?.[1]
      ?? /operation "workspace\.connection\.(?:mint|refresh)" failed: (\d+)/.exec(message)?.[1],
  )
}

function connectionFailureCooldownMs(err: unknown, options: Options) {
  const status = connectionFailureStatus(err)
  if (status === 401 && !new Headers(options.headers).has("authorization")) return 0
  if (status === 401 || status === 403 || status === 404 || status === 409) return TERMINAL_FAILURE_COOLDOWN_MS
  return TRANSIENT_FAILURE_COOLDOWN_MS
}

function normalizeConnectionFailure(err: unknown): never {
  const status = connectionFailureStatus(err)
  if (Number.isFinite(status) && status > 0) throw new Error(`Workspace connection failed: ${status}`)
  throw err
}

/**
 * Mint or refresh a workspace connection body.
 *
 * Desktop signed mode: renderer has no bearer — named AccountPort ops reach the
 * hosted control plane through Electron main. `options.request` always wins so
 * tests (and any explicit override) keep the authFetch-shaped path.
 */
async function fetchConnectionBody(
  operation: "workspace.connection.mint" | "workspace.connection.refresh",
  params: { id: string; previousJti?: string },
  options: Options,
): Promise<unknown> {
  const url = operation === "workspace.connection.mint"
    ? workspaceConnectionUrl({ serverUrl: options.serverUrl, workspaceId: params.id })
    : workspaceConnectionRefreshUrl({ serverUrl: options.serverUrl, workspaceId: params.id })
  const init: RequestInit | undefined = operation === "workspace.connection.refresh"
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(params.previousJti ? { previousJti: params.previousJti } : {}),
        }),
      }
    : undefined

  if (!options.request) {
    const run = accountRun()
    if (run) {
      try {
        const hostedParams: Record<string, unknown> = { id: params.id }
        if (params.previousJti) hostedParams.previousJti = params.previousJti
        return decodeHostedResult(operation, await run(operation, hostedParams))
      } catch (err) {
        normalizeConnectionFailure(err)
      }
    }
  }

  return (options.request ?? authFetch)(url, controlPlaneInit(options, init)).then(responseJson)
}

export async function openWorkspaceConnection(workspaceId: string, options: Options = {}) {
  const resolvedOptions = await connectionOptions(options)
  const key = connectionCacheKey(workspaceId, resolvedOptions)
  const cached = queryClient.getQueryData<Promise<WorkspaceConnectionInfo>>(key)
  if (cached) return cached

  const evictWhenCurrent = (pending: Promise<WorkspaceConnectionInfo>, delayMs: number) => {
    if (delayMs <= 0) {
      if (queryClient.getQueryData<Promise<WorkspaceConnectionInfo>>(key) === pending) {
        queryClient.removeQueries({ queryKey: key })
      }
      return
    }
    globalThis.setTimeout(() => {
      if (queryClient.getQueryData<Promise<WorkspaceConnectionInfo>>(key) === pending) {
        queryClient.removeQueries({ queryKey: key })
      }
    }, Math.max(0, delayMs))
  }

  const pending: Promise<WorkspaceConnectionInfo> = workspaceConnectionWithRetry(
    { operation: "workspace.connection.mint", id: workspaceId },
    resolvedOptions,
    workspaceId,
  )
    .then((connection) => {
      observer?.onConnected(connection)
      const ttl = connection.tokenExpiresAt - (resolvedOptions.now ?? Date.now)()
      evictWhenCurrent(pending, ttl - (resolvedOptions.refreshWindowMs ?? 60_000))
      return connection
    })
    .catch((err) => {
      observer?.onFailed(workspaceId)
      // Negative-cache the failure for a cooldown instead of evicting now, so
      // the swarm of mounted panes does not immediately re-mint a doomed
      // connection. Callers still receive the rejection and surface offline.
      evictWhenCurrent(pending, connectionFailureCooldownMs(err, resolvedOptions))
      throw err
    })
  // Keep an unhandled-rejection guard: the cached promise may sit unconsumed
  // until its cooldown eviction, and a bare rejected promise in the cache would
  // otherwise trip the runtime's unhandledrejection reporter.
  pending.catch(() => {})
  queryClient.setQueryData(key, pending)
  return pending
}

export function forgetWorkspaceConnection(workspaceId: string, options: Options = {}) {
  const serverUrl = normalizedServerUrl(options.serverUrl)
  queryClient.removeQueries({
    predicate: (query) =>
      query.queryKey[0] === "shell" &&
      query.queryKey[1] === "workspace-connection" &&
      query.queryKey[2] === serverUrl &&
      query.queryKey[3] === workspaceId,
  })
}

async function workspaceConnectionWithRetry(
  input: {
    operation: "workspace.connection.mint" | "workspace.connection.refresh"
    id: string
    previousJti?: string
  },
  options: Options,
  workspaceId?: string,
) {
  const attempts = options.provisioningMaxAttempts ?? DEFAULT_PROVISIONING_MAX_ATTEMPTS
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const body = await fetchConnectionBody(input.operation, input, options)
    if (isRateLimited(body)) {
      await sleep(options, provisioningRetryDelay(body.retryAfterMs))
      continue
    }
    if (!isProvisioning(body)) return parseConnection(body)
    if (workspaceId) observer?.onProvisioning?.(workspaceId, provisioningBootMode(body))
    await sleep(options, provisioningRetryDelay(body.retryAfterMs))
  }
  throw new Error("Workspace runtime is still provisioning")
}

export async function refreshWorkspaceConnection(connection: WorkspaceConnectionInfo, options: Options = {}) {
  const previousJti = runtimeAccessTokenJti(connection.runtimeAccessToken)
  return workspaceConnectionWithRetry(
    {
      operation: "workspace.connection.refresh",
      id: connection.workspaceId,
      ...(previousJti ? { previousJti } : {}),
    },
    options,
    connection.workspaceId,
  )
}

export function createWorkspaceRelayConnection(input: WorkspaceConnectionInfo, options: Options = {}) {
  let current = input
  const relayRequest = options.relayRequest ?? fetch
  const webSocket = options.webSocket ?? WebSocket
  const now = options.now ?? Date.now
  const refreshWindowMs = options.refreshWindowMs ?? 60_000

  const refresh = async () => {
    current = await refreshWorkspaceConnection(current, options)
    observer?.onConnected(current)
    return current
  }

  const ensureFresh = async () => {
    if (current.tokenExpiresAt - now() <= refreshWindowMs) await refresh()
    return current
  }

  const relayFetch = async (path: string, init: RequestInit = {}) => {
    const connection = await ensureFresh()
    if (connection.directRuntimeUrl) {
      const headers = new Headers(init.headers)
      headers.delete("Authorization")
      return relayRequest(`${connection.directRuntimeUrl}${path}`, {
        ...init,
        redirect: init.redirect ?? "manual",
        headers,
      })
    }
    const headers = new Headers(init.headers)
    headers.set("Authorization", `Bearer ${connection.runtimeAccessToken}`)
    const res = await relayRequest(`${connection.relayUrl}/workspaces/${encodeURIComponent(connection.workspaceId)}${path}`, {
      ...init,
      redirect: init.redirect ?? "manual",
      headers,
    })
    if (res.status !== 401) return res
    const retry = await refresh()
    headers.set("Authorization", `Bearer ${retry.runtimeAccessToken}`)
    return relayRequest(`${retry.relayUrl}/workspaces/${encodeURIComponent(retry.workspaceId)}${path}`, {
      ...init,
      redirect: init.redirect ?? "manual",
      headers,
    })
  }

  const relayWebSocket = async (path: string, protocols: string[] = []) => {
    const connection = await ensureFresh()
    if (connection.directRuntimeUrl) {
      return new webSocket(`${connection.directRuntimeUrl}${path}`.replace(/^http/, "ws"), protocols)
    }
    return new webSocket(
      `${connection.relayUrl}/workspaces/${encodeURIComponent(connection.workspaceId)}${path}`.replace(/^http/, "ws"),
      [runtimeAccessTokenProtocol(connection.runtimeAccessToken), ...protocols],
    )
  }

  return {
    get connection() {
      return current
    },
    refresh,
    fetch: relayFetch,
    webSocket: relayWebSocket,
  }
}
