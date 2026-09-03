/**
 * Shared API helpers for web and desktop.
 */
import { bypassFetchThrottle, isEventStreamPath, throttledFetch } from "@/lib/fetch-throttle";
import { DEFAULT_LOCAL_CLAXEDO_SERVER_URL } from "@/platform/api/local-server"
export { isDemoMode, isDemoPath, isEmbedMode } from "@/lib/runtime-mode"
import { isDemoMode } from "@/lib/runtime-mode"

/**
 * How a build hands this transport a bearer, without this transport knowing
 * who issues one.
 *
 * This module used to call `getAuthToken` from `@/platform/auth/auth-client`
 * directly. `auth-client.ts` is hosted; this file is shared. The transport
 * cannot import a credential source only the hosted build has.
 * `configureApiRuntime` installs the bearer from the composition root instead.
 *
 * Deliberately NOT a `*-port.ts` contract module in the shape of
 * `platform/runtime/workspace-startup-port.ts`. That seam names three hosted
 * OPERATIONS a local build cannot perform, so `workspaceStartup()` throws when
 * unbound — a local build reaching it is a wiring bug. A bearer is the
 * opposite: "there is no token" is the local product's NORMAL state (the local
 * server authenticates by loopback, and `authFetch` already falls through to
 * the configured desktop basic-auth password). So it belongs with the
 * credential this module already owns, behind the binder it already has —
 * `configureApiRuntime`, which is where `password` is installed by exactly the
 * same composition roots.
 *
 * `skipCache` is the only option any caller passes: the force-refresh retry
 * below asks for a fresh JWT after the server rejects a cached one.
 */
export type BearerTokenSource = (options?: { skipCache?: boolean }) => Promise<string | null>

export const releaseValidationOperations = [
  "private_session",
  "stream",
  "revocation",
  "wrong_org",
  "replay",
  "outage",
] as const

export type ReleaseValidationOperation = (typeof releaseValidationOperations)[number]

export function releaseValidationOperation(value: unknown): ReleaseValidationOperation | undefined {
  return typeof value === "string"
    ? releaseValidationOperations.find((operation) => operation === value)
    : undefined
}

type ReleaseValidationBinding = {
  coreOrigin: string
  operation: ReleaseValidationOperation
}

const cfg = {
  base: undefined as string | undefined,
  password: "",
  bearerToken: undefined as BearerTokenSource | undefined,
  browserCredentials: undefined as RequestCredentials | undefined,
  releaseValidation: undefined as ReleaseValidationBinding | undefined,
}

function envString(input: unknown) {
  if (typeof input !== "string") return undefined
  if (input === "null" || input === "undefined") return undefined
  return input
}

export function configureApiRuntime(input: {
  baseUrl?: string | null
  password?: string | null
  bearerToken?: BearerTokenSource | null
  browserCredentials?: RequestCredentials | null
  releaseValidation?: ReleaseValidationBinding | null
}) {
  if ("baseUrl" in input) {
    cfg.base = normalized(input.baseUrl ?? undefined)
  }
  if ("password" in input) {
    cfg.password = input.password?.trim() ?? ""
  }
  if ("bearerToken" in input) {
    cfg.bearerToken = input.bearerToken ?? undefined
  }
  if ("browserCredentials" in input) {
    cfg.browserCredentials = input.browserCredentials ?? undefined
  }
  if ("releaseValidation" in input) {
    const binding = input.releaseValidation ?? undefined
    if (binding) {
      const origin = new URL(binding.coreOrigin)
      if (origin.origin !== binding.coreOrigin || !/^https?:$/.test(origin.protocol)) {
        throw new Error("release validation coreOrigin must be an exact HTTP(S) origin")
      }
    }
    cfg.releaseValidation = binding
  }
}

export function resetApiRuntime() {
  cfg.base = undefined
  cfg.password = ""
  cfg.bearerToken = undefined
  cfg.browserCredentials = undefined
  cfg.releaseValidation = undefined
}

/**
 * Read the bound bearer, for the callers that build an `Authorization` header
 * themselves instead of going through `authFetch`.
 *
 * Two of them exist — `features/workspaces/actions/project-actions.tsx`
 * (destroying a cloud sandbox) and `platform/runtime/agent/agent-runtime-client.ts`
 * (the signed control-plane init) — and both used to import `getAuthToken` from
 * `@/platform/auth/auth-client` for one call each. That is the same edge this
 * module cut for itself above, and it put the auth vendor in the LOCAL bundle through two
 * modules the local shell genuinely needs.
 *
 * So the binder this module already owns answers for them too. Reading is
 * deliberately a plain function rather than a second port: there is exactly one
 * credential here, `configureApiRuntime` is where it is installed, and a caller
 * that wants it should not have to know which build installed one.
 *
 * `null` when no build bound a source is the local product's normal state, not
 * a failure — both call sites already omit the header when there is no token,
 * which is also what they did before sign-in on the hosted app.
 */
export async function apiBearerToken(options?: { skipCache?: boolean }): Promise<string | null> {
  return (await cfg.bearerToken?.(options)) ?? null
}

// Claxedo's own hosted app only. This used to also match `opencode.ai` and its
// subdomains, which trusted upstream's hosted app as if it were ours.
export function isHostedAppHostname(hostname: string | undefined) {
  const host = hostname?.toLowerCase()
  return host === "claxedo.com" || host?.endsWith(".claxedo.com") === true
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
  // Only a page actually served over http(s) can double as its own API origin.
  // The packaged desktop renderer is loaded via `win.loadFile(...)`, so it is a
  // file:// page — and Chromium reports its origin as the literal string
  // "file://" with an empty hostname, which slipped past both guards below (the
  // opaque-origin check only matches the origin spelled "null", and the
  // loopback check reads the *hostname*). This then handed back "file://" as
  // the API base, so every call resolved to `file:///session?...` /
  // `file:///api/workspace/resolve?...` and failed with ERR_FILE_NOT_FOUND: no
  // session would start and no harness would switch in the shipped app.
  if (!/^https?:$/.test(window.location.protocol)) return undefined
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
  return errorCode(
    await response
      .clone()
      .json()
      .catch(() => undefined),
  )
}

const apiFetchDebugCounts = new Map<string, number>()
let apiFetchDebugSequence = 0

function apiFetchDebugEnabled(route: string) {
  if (typeof window === "undefined") return false
  if (route !== "/question" && route !== "/permission" && route !== "/session/status") {
    return localStorage.getItem("claxedo.debug.api-fetch") === "1"
  }
  return (
    import.meta.env.DEV ||
    localStorage.getItem("claxedo.debug.request-loop") === "1" ||
    localStorage.getItem("claxedo.debug.api-fetch") === "1"
  )
}

/**
 * Whether this request may carry the control plane's session cookie.
 *
 * `browserCredentials` is `"include"` whenever the control plane authenticates
 * the browser with a cookie — but `authFetch` is also the egress for the RELAY,
 * a different origin that authenticates with a Runtime Access Token in the
 * `Authorization` header and has no session cookie of ours at all. Sending
 * credentials there is wrong twice over: it offers the control plane's cookie
 * to another host, and — because a credentialed cross-origin request requires
 * `Access-Control-Allow-Credentials: true` in the preflight response, which a
 * bearer service correctly does not send — the browser refuses to make the
 * request at all.
 *
 * That refusal is what the hosted app reported as "Workspace host is offline":
 *
 *   Response to preflight request doesn't pass access control check: The value
 *   of the 'Access-Control-Allow-Credentials' header in the response is ''
 *   which must be 'true' when the request's credentials mode is 'include'.
 *
 * — while the relay was up, the host tunnel was connected, and the laptop was
 * answering every request that actually reached it.
 *
 * So the cookie goes to the control plane and to loopback, and nowhere else.
 * Other origins keep whatever the caller asked for, which defaults to
 * `same-origin`.
 */
function credentialsFor(url: string, requested: RequestCredentials | undefined): RequestCredentials | undefined {
  if (!cfg.browserCredentials) return requested
  if (localUrl(url)) return cfg.browserCredentials
  try {
    const target = new URL(url, typeof window === "undefined" ? undefined : window.location.origin)
    // `getClaxedoServerUrl()`, NOT the page's own origin. On a hosted
    // deployment the app and the control plane are DIFFERENT hosts
    // (`app-…` and `cf-…`), and `configureApiRuntime` is not called with a
    // `baseUrl` there — so treating the page origin as the control plane
    // would withhold the cookie from the very service that needs it and every
    // request would 401.
    for (const origin of [getClaxedoServerUrl(), cfg.base, cfg.releaseValidation?.coreOrigin]) {
      if (!origin) continue
      if (target.origin === new URL(origin, target.origin).origin) return cfg.browserCredentials
    }
  } catch {
    // An unparseable target is not the control plane.
  }
  return requested
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
    .filter((line) => line && !line.includes("/src/platform/api/api.ts"))
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
    const throttle = (
      window as typeof window & {
        __fetchThrottle?: { inFlight: number; queued: number; cap: number }
      }
    ).__fetchThrottle
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
  // Unsigned local keeps the loopback engine stream. A bound bearer means this
  // document is a signed client — including 127.0.0.1 e2e fixtures — so it must
  // use the control-plane lifecycle bus. Skipping that rewrite for every
  // `localUrl` left signed cloud subscribed to a dead `/global/event` path and
  // rail rows never appeared from session.lifecycle.
  if (localUrl(url.href) && !cfg.bearerToken) return { input, init }
  url.pathname = "/api/wr/events"
  if (input instanceof Request) {
    return {
      input: new Request(url, {
        method: input.method,
        headers: input.headers,
        signal: input.signal,
        cache: input.cache,
        redirect: input.redirect,
        credentials: input.credentials,
        mode: input.mode,
        referrer: input.referrer,
        integrity: input.integrity,
      }),
      init,
    }
  }
  return { input: url, init }
}

function throttleInit(init: RequestInit | undefined, input: string | URL | Request) {
  if (isEventStreamPath(input)) return bypassFetchThrottle(init ?? {})
  return init
}

/**
 * Get the base URL for claxedo-server API calls (PTY, documents, events, etc.)
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
  // hardcoded default so PTY/events/documents calls reach the right server.
  if (cfg.base) return cfg.base
  return DEFAULT_LOCAL_CLAXEDO_SERVER_URL
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
      return DEFAULT_LOCAL_CLAXEDO_SERVER_URL
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
 * The bearer comes from whatever `configureApiRuntime({ bearerToken })`
 * installed. A build that installed none — the local product — simply has no
 * token, which is the same state a signed build is in before sign-in, so every
 * branch below already handled it.
 *
 * When the server rejects the cached bearer token as expired
 * (`invalid_bearer_token`), force-refresh the JWT once and retry. This
 * avoids the "everything stuck in loading" mode where a stale token
 * causes every request to silently 401 and the panels never recover.
 */
export async function authFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const eventInput = signedRuntimeEventInput(input, init)
  input = eventInput.input
  init = eventInput.init
  const apiFetchDebug = beginApiFetchDebug(input)
  const cache = localUrl(apiFetchUrl(input)) ? ("no-store" as const) : init?.cache
  const credentials = credentialsFor(apiFetchUrl(input), init?.credentials)
  const buildRequest = async (
    forceRefreshToken: boolean,
  ): Promise<{ request: Request | string | URL; init?: RequestInit; token: string | null }> => {
    const token = await apiBearerToken(forceRefreshToken ? { skipCache: true } : undefined)

    const setAuth = (headers: Headers) => {
      if (headers.has("Authorization") && !forceRefreshToken) return
      if (token) {
        headers.set("Authorization", `Bearer ${token}`)
        return
      }
      if (!cfg.password) return
      headers.set("Authorization", `Basic ${btoa(`opencode:${cfg.password}`)}`)
    }

    const setReleaseValidation = (headers: Headers) => {
      const binding = cfg.releaseValidation
      if (!binding || headers.has("x-claxedo-multiplayer-validation-operation")) return
      let target: URL
      try {
        target = new URL(apiFetchUrl(input), cfg.base ?? (typeof window === "undefined" ? undefined : window.location.origin))
      } catch {
        return
      }
      if (target.origin !== binding.coreOrigin) return
      headers.set("x-claxedo-multiplayer-validation-operation", binding.operation)
    }

    if (input instanceof Request) {
      const existingHeaders = new Headers(input.headers)
      if (forceRefreshToken) existingHeaders.delete("Authorization")
      setAuth(existingHeaders)
      setReleaseValidation(existingHeaders)
      return { request: new Request(input, { ...init, cache, credentials, headers: existingHeaders }), token }
    }

    const headers = new Headers(init?.headers)
    if (forceRefreshToken) headers.delete("Authorization")
    setAuth(headers)
    setReleaseValidation(headers)
    if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json")
    }
    return { request: input, init: { ...init, cache, credentials, headers }, token }
  }

  const withoutAuthorization = async () => {
    if (input instanceof Request) {
      const headers = new Headers(input.headers)
      headers.delete("Authorization")
      return fetch(new Request(input, { ...init, cache, credentials, headers }))
    }
    const headers = new Headers(init?.headers)
    headers.delete("Authorization")
    if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json")
    }
    return fetch(input, { ...init, cache, credentials, headers })
  }

  // Every authed fetch flows through a global concurrency limiter so a
  // bootstrap that fans out 30+ requests can't pile them all onto the
  // browser's 6-slot HTTP/1.1 connection pool simultaneously. SSE streams
  // and explicit bypass-marked requests skip the cap — see
  // `./fetch-throttle.ts` for the policy.
  const first = await buildRequest(false)
  const firstResponse = first.request instanceof Request
    ? await throttledFetch(() => fetch(first.request as Request), throttleInit(undefined, first.request), first.request)
    : await throttledFetch(() => fetch(first.request as string | URL, first.init), throttleInit(first.init, first.request), first.request)
  apiFetchDebug("first-response", firstResponse)

  if (firstResponse.status === 403 && first.token) {
    if ((await responseErrorCode(firstResponse)) === "signed_cloud_auth_disabled") {
      const stripped = await withoutAuthorization()
      apiFetchDebug("stripped-response", stripped)
      if (stripped.status === 403) return firstResponse
      return stripped
    }
  }

  // Only retry if we sent a bearer token and the server told
  // us it's invalid. We don't retry basic-auth failures; those need
  // user action regardless.
  if (firstResponse.status !== 401 || !first.token) return firstResponse

  // Peek at the body without consuming the original Response.
  const code = await responseErrorCode(firstResponse)
  if (code !== "invalid_bearer_token") return firstResponse

  // Step 2: force-refresh the bearer token and retry.
  const retried = await buildRequest(true)
  const retriedResponse = retried.request instanceof Request
    ? await throttledFetch(() => fetch(retried.request as Request), throttleInit(undefined, retried.request), retried.request)
    : await throttledFetch(() => fetch(retried.request as string | URL, retried.init), throttleInit(retried.init, retried.request), retried.request)
  apiFetchDebug("retried-response", retriedResponse)

  // If the force-refreshed token is STILL rejected (the auth
  // session is dead, JWKS rotated mid-flight, or the user's
  // instance and the server's are out of sync — common in local dev
  // when env vars drift), drop the Authorization header entirely and
  // try once more. claxedo-server's unsigned-local path serves the
  // same routes when no bearer is present, so directory-scoped UI
  // (file tree, diff list, etc.) still works for the developer
  // without forcing a re-login dance.
  if (retriedResponse.status !== 401 && retriedResponse.status !== 403) return retriedResponse
  if (retriedResponse.status === 403) {
    if ((await responseErrorCode(retriedResponse)) !== "signed_cloud_auth_disabled") return retriedResponse
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

function loopbackHttpUrl(input: string | undefined) {
  if (!input) return false
  try {
    const url = new URL(input)
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]")
  } catch {
    return false
  }
}

export function isLoopbackHttpUrl(input: string | undefined) {
  return loopbackHttpUrl(input)
}

export function usesUnsignedLocalTransport(input: string | undefined) {
  return loopbackHttpUrl(input)
}

export function unsignedLocalFetch(input: string | URL | Request, init?: RequestInit) {
  if (input instanceof Request) {
    const headers = new Headers(init?.headers ?? input.headers)
    headers.delete("Authorization")
    return globalThis.fetch(new Request(input, { ...init, headers }))
  }
  const headers = new Headers(init?.headers)
  headers.delete("Authorization")
  return globalThis.fetch(input, { ...init, headers })
}
