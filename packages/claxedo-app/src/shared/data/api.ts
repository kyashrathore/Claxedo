/**
 * Shared API helpers for web and desktop.
 */
import { getAuthToken } from "@/shared/data/auth-client";
import { throttledFetch } from "@/utils/fetch-throttle";

const cfg = {
  base: undefined as string | undefined,
  password: "",
}

function envString(input: unknown) {
  if (typeof input !== "string") return undefined
  if (input === "null" || input === "undefined") return undefined
  return input
}

export function configureApiRuntime(input: {
  baseUrl?: string | null
  password?: string | null
}) {
  if ("baseUrl" in input) {
    cfg.base = normalized(input.baseUrl ?? undefined)
  }
  if ("password" in input) {
    cfg.password = input.password?.trim() ?? ""
  }
}

export function resetApiRuntime() {
  cfg.base = undefined
  cfg.password = ""
}

/**
 * Returns true when the app is running in demo/preview mode.
 * Triggered by the `/demo` path prefix in the URL.
 */
export function isDemoPath(path: string) {
  return path === "/demo" || path.startsWith("/demo/")
}

export function isDemoMode() {
  if (typeof window === "undefined") return false
  return isDemoPath(window.location.pathname)
}

export function isEmbedMode() {
  if (typeof window === "undefined") return false
  return new URLSearchParams(window.location.search).has("embed")
}

export function isHostedAppHostname(hostname: string | undefined) {
  const host = hostname?.toLowerCase()
  return host === "opencode.ai" || host?.endsWith(".opencode.ai") === true
}

export function fixDir(input: string | undefined): string | undefined {
  const txt = input?.trim()
  if (!txt) return undefined
  if (txt.startsWith("/")) return txt
  const hit = ["/Users/", "/private/", "/Volumes/", "/home/"]
    .map((item) => txt.indexOf(item))
    .filter((item) => item >= 0)
    .sort((a, b) => a - b)[0]

  if (hit !== undefined) return txt.slice(hit)
  if (/^(Users|private|Volumes|home)\//.test(txt)) return `/${txt}`
  return txt
}

// Shared URL normalizer used by every Claxedo URL builder (rubric Q6).
// Trim whitespace, strip trailing slashes, and treat falsy input as
// "no URL". Callers layer their own fallbacks on top (the gateway falls
// back to `getClaxedoServerUrl()`; the relay-connection helper requires
// the URL upstream).
export function normalizeUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim()
  if (!trimmed) return undefined
  return trimmed.replace(/\/+$/, "")
}

function normalized(url: string | undefined): string | undefined {
  return normalizeUrl(url)
}

function localHost(hostname: string | undefined) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
}

function localUrl(url: string | undefined): boolean {
  try {
    return localHost(new URL(url ?? "").hostname)
  } catch {
    return false
  }
}

function sameOriginForRemoteLocalBackend(url: string | undefined): string | undefined {
  if (typeof window === "undefined") return undefined
  if (window.location.origin === "null") return undefined
  if (localHost(window.location.hostname)) return undefined
  if (url && !localUrl(url)) return undefined
  return normalized(window.location.origin)
}

function localBackendForCurrentHost(url: string | undefined): string | undefined {
  if (typeof window === "undefined") return undefined
  if (!url || !localHost(window.location.hostname) || !localUrl(url)) return undefined
  try {
    const next = new URL(url)
    // claxedo-server binds IPv4 loopback in local dev; avoid localhost resolving to ::1.
    next.hostname = "127.0.0.1"
    return normalized(next.toString())
  } catch {
    return undefined
  }
}

function errorCode(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("error" in input)) return undefined
  if (!input.error || typeof input.error !== "object" || !("code" in input.error)) return undefined
  return typeof input.error.code === "string" ? input.error.code : undefined
}

async function responseErrorCode(response: Response) {
  return errorCode(await response.clone().json().catch(() => undefined))
}

const apiFetchDebugCounts = new Map<string, number>()
let apiFetchDebugSequence = 0

function apiFetchDebugEnabled(route: string) {
  if (typeof window === "undefined") return false
  if (
    route !== "/question" &&
    route !== "/permission" &&
    route !== "/session/status"
  ) {
    return localStorage.getItem("claxedo.debug.api-fetch") === "1"
  }
  return import.meta.env.DEV ||
    localStorage.getItem("claxedo.debug.request-loop") === "1" ||
    localStorage.getItem("claxedo.debug.api-fetch") === "1"
}

function apiFetchUrl(input: string | URL | Request) {
  if (input instanceof Request) return input.url
  if (input instanceof URL) return input.toString()
  return input
}

function apiFetchRoute(url: string) {
  try {
    return new URL(url, window.location.origin).pathname
  } catch {
    return url.split("?")[0] ?? url
  }
}

function apiFetchStack() {
  return new Error().stack
    ?.split("\n")
    .slice(2, 8)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes("/src/shared/data/api.ts"))
}

function beginApiFetchDebug(input: string | URL | Request) {
  const url = apiFetchUrl(input)
  const route = apiFetchRoute(url)
  if (!apiFetchDebugEnabled(route)) return () => {}

  const id = ++apiFetchDebugSequence
  const start = Date.now()
  const count = (apiFetchDebugCounts.get(route) ?? 0) + 1
  apiFetchDebugCounts.set(route, count)

  const debug = (phase: string, response?: Response) => {
    const throttle = (window as typeof window & {
      __fetchThrottle?: { inFlight: number; queued: number; cap: number }
    }).__fetchThrottle
    console.debug("[claxedo:api-fetch]", phase, {
      id,
      route,
      count,
      status: response?.status,
      elapsedMs: Date.now() - start,
      throttle,
      url,
      stack: phase === "start" ? apiFetchStack() : undefined,
    })
  }

  debug("start")
  return debug
}

function signedRuntimeEventInput(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(apiFetchUrl(input), getClaxedoServerUrl())
  if (url.pathname !== "/global/event" && url.pathname !== "/event") return { input, init }
  url.pathname = "/api/wr/events"
  if (input instanceof Request) return { input: new Request(url, input), init }
  return { input: url, init }
}

/**
 * Get the base URL for claxedo-server API calls (PTY, pages, events, etc.)
 * In demo mode returns the current origin so MSW service worker intercepts requests.
 */
export function getClaxedoServerUrl(): string {
  if (isDemoMode()) return normalized(window.location.origin) ?? window.location.origin
  const envUrl = envString(import.meta.env.VITE_CLAXEDO_SERVER_URL)
  const remoteOrigin = sameOriginForRemoteLocalBackend(envUrl)
  if (remoteOrigin) return remoteOrigin
  const localOrigin = localBackendForCurrentHost(envUrl)
  if (localOrigin) return localOrigin
  if (envUrl?.trim()) return envUrl.trim().replace(/\/+$/, "")
  // In desktop mode, claxedo-server runs on a dynamic port and the URL is
  // set via configureApiRuntime() during init. Fall back to it before the
  // hardcoded default so PTY/events/pages calls reach the right server.
  if (cfg.base) return cfg.base
  return "http://127.0.0.1:3001"
}

/**
 * Returns the explicitly-configured server URL (env var only), with
 * VITE_CLAXEDO_SERVER_URL preferred over the legacy VITE_OPENCODE_BACKEND_URL
 * compatibility alias. Returns `undefined` when neither env var is
 * set (callers fall back to runtime detection / default).
 *
 * Distinct from `getClaxedoServerUrl()` which always returns a usable URL.
 */
export function getConfiguredClaxedoServerUrl(): string | undefined {
  const claxedo = envString(import.meta.env.VITE_CLAXEDO_SERVER_URL)
  if (claxedo?.trim()) return claxedo.trim().replace(/\/+$/, "")
  const legacy = envString(import.meta.env.VITE_OPENCODE_BACKEND_URL)
  if (legacy?.trim()) return legacy.trim().replace(/\/+$/, "")
  return undefined
}

/**
 * Get the default base URL for API calls.
 * On desktop, reads the sidecar URL set during init.
 */
export function getDefaultBaseUrl(): string {
  // Demo mode: use current origin so MSW service worker intercepts all requests
  if (isDemoMode()) return window.location.origin

  if (cfg.base) return cfg.base

  // Desktop: sidecar URL is set during init
  const serverUrl = (window as typeof window & { __OPENCODE__?: { serverUrl?: string } }).__OPENCODE__?.serverUrl
  if (serverUrl) return normalized(serverUrl) ?? serverUrl

  const backendUrl = normalized(envString(import.meta.env.VITE_OPENCODE_BACKEND_URL))
  const remoteOrigin = sameOriginForRemoteLocalBackend(backendUrl)
  if (remoteOrigin) return remoteOrigin
  if (backendUrl) return backendUrl

  if (typeof window !== "undefined") {
    const host = window.location.hostname
    if (localHost(host) && window.location.port === "4444") {
      return "http://127.0.0.1:3001"
    }
  }

  // The default backend is the control plane (the Worker), NEVER the static app
  // origin. On a Pages + Worker split, the app is served from Pages but the API
  // lives on the Worker; falling back to `window.location.origin` here pointed
  // control-plane calls (e.g. /api/workspace/resolve) at Pages, which answered
  // with the SPA index.html (HTTP 200) and broke session creation when the app
  // parsed HTML as JSON. `getClaxedoServerUrl()` resolves VITE_CLAXEDO_SERVER_URL
  // / the desktop sidecar / the local server — and only returns the origin in
  // demo mode, where same-origin MSW interception is intended.
  return getClaxedoServerUrl()
}

/**
 * Make an authenticated fetch request.
 * Prefers cloud bearer auth and falls back to configured desktop basic auth.
 *
 * When the server rejects the cached Clerk token as expired
 * (`invalid_bearer_token`), force-refresh the JWT once and retry. This
 * avoids the "everything stuck in loading" mode where a stale token
 * causes every request to silently 401 and the panels never recover.
 */
export async function authFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const eventInput = signedRuntimeEventInput(input, init)
  input = eventInput.input
  init = eventInput.init
  const apiFetchDebug = beginApiFetchDebug(input)
  const buildRequest = async (forceRefreshToken: boolean): Promise<{ request: Request | string | URL; init?: RequestInit; token: string | null }> => {
    const token = await getAuthToken(forceRefreshToken ? { skipCache: true } : undefined)

    const setAuth = (headers: Headers) => {
      if (headers.has("Authorization") && !forceRefreshToken) return
      if (token) {
        headers.set("Authorization", `Bearer ${token}`)
        return
      }
      if (!cfg.password) return
      headers.set("Authorization", `Basic ${btoa(`opencode:${cfg.password}`)}`)
    }

    if (input instanceof Request) {
      const existingHeaders = new Headers(input.headers)
      if (forceRefreshToken) existingHeaders.delete("Authorization")
      setAuth(existingHeaders)
      return { request: new Request(input, { ...init, headers: existingHeaders }), token }
    }

    const headers = new Headers(init?.headers)
    if (forceRefreshToken) headers.delete("Authorization")
    setAuth(headers)
    if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json")
    }
    return { request: input, init: { ...init, headers }, token }
  }

  const withoutAuthorization = async () => {
    if (input instanceof Request) {
      const headers = new Headers(input.headers)
      headers.delete("Authorization")
      return fetch(new Request(input, { ...init, headers }))
    }
    const headers = new Headers(init?.headers)
    headers.delete("Authorization")
    if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json")
    }
    return fetch(input, { ...init, headers })
  }

  // Every authed fetch flows through a global concurrency limiter so a
  // bootstrap that fans out 30+ requests can't pile them all onto the
  // browser's 6-slot HTTP/1.1 connection pool simultaneously. SSE streams
  // and explicit bypass-marked requests skip the cap — see
  // `./fetch-throttle.ts` for the policy.
  const first = await buildRequest(false)
  const firstResponse = first.request instanceof Request
    ? await throttledFetch(() => fetch(first.request as Request), undefined, first.request)
    : await throttledFetch(() => fetch(first.request as string | URL, first.init), first.init, first.request)
  apiFetchDebug("first-response", firstResponse)

  if (firstResponse.status === 403 && first.token) {
    if (await responseErrorCode(firstResponse) === "signed_cloud_auth_disabled") {
      const stripped = await withoutAuthorization()
      apiFetchDebug("stripped-response", stripped)
      if (stripped.status === 403) return firstResponse
      return stripped
    }
  }

  // Only retry if we sent a bearer (Clerk) token and the server told
  // us it's invalid. We don't retry basic-auth failures; those need
  // user action regardless.
  if (firstResponse.status !== 401 || !first.token) return firstResponse

  // Peek at the body without consuming the original Response.
  const code = await responseErrorCode(firstResponse)
  if (code !== "invalid_bearer_token") return firstResponse

  // Step 2: force-refresh the Clerk JWT and retry.
  const retried = await buildRequest(true)
  const retriedResponse = retried.request instanceof Request
    ? await throttledFetch(() => fetch(retried.request as Request), undefined, retried.request)
    : await throttledFetch(() => fetch(retried.request as string | URL, retried.init), retried.init, retried.request)
  apiFetchDebug("retried-response", retriedResponse)

  // If the force-refreshed token is STILL rejected (Clerk
  // session is dead, JWKS rotated mid-flight, or the user's Clerk
  // instance and the server's are out of sync — common in local dev
  // when env vars drift), drop the Authorization header entirely and
  // try once more. claxedo-server's unsigned-local path serves the
  // same routes when no bearer is present, so directory-scoped UI
  // (file tree, diff list, etc.) still works for the developer
  // without forcing a re-login dance.
  if (retriedResponse.status !== 401 && retriedResponse.status !== 403) return retriedResponse
  if (retriedResponse.status === 403) {
    if (await responseErrorCode(retriedResponse) !== "signed_cloud_auth_disabled") return retriedResponse
  }

  const stripped = await withoutAuthorization()
  apiFetchDebug("retry-stripped-response", stripped)
  // If unsigned-local also rejects (the route genuinely requires
  // auth and the server's not in local-dev mode), surface the
  // original auth failure so callers see the real auth error.
  if (stripped.status === retriedResponse.status) return retriedResponse
  return stripped
}

function jsonBody(body: unknown) {
  return body === undefined ? undefined : JSON.stringify(body)
}

async function jsonRequest<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await authFetch(apiUrl(url), init)
  if (!res.ok) {
    const err = await res.text()
    throw new Error(err || `Request failed: ${res.status}`)
  }
  return res.json()
}

function apiUrl(url: string) {
  if (!url.startsWith("/")) return url
  return new URL(url, getClaxedoServerUrl()).toString()
}

export const api = {
  get<T = unknown>(url: string): Promise<T> {
    return jsonRequest<T>(url)
  },

  post<T = unknown>(url: string, body?: unknown): Promise<T> {
    return jsonRequest<T>(url, {
      method: "POST",
      body: jsonBody(body),
    })
  },

  put<T = unknown>(url: string, body?: unknown): Promise<T> {
    return jsonRequest<T>(url, {
      method: "PUT",
      body: jsonBody(body),
    })
  },

  patch<T = unknown>(url: string, body?: unknown): Promise<T> {
    return jsonRequest<T>(url, {
      method: "PATCH",
      body: jsonBody(body),
    })
  },

  delete<T = unknown>(url: string): Promise<T> {
    return jsonRequest<T>(url, {
      method: "DELETE",
    })
  },
}
