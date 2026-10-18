import { createOriginMatcher, DEFAULT_RELAY_APP_ORIGINS, parseAllowedOrigins, RELAY_ALLOWED_REQUEST_HEADERS } from "./cors-origins"
import { errorBody } from "./http"

/**
 * What a browser may read off a relayed response beyond the CORS-safelisted
 * names: the runtime's read position and page cursors, the relay's trace and
 * placement, and the timing that `timing-allow-origin` lets it attribute.
 */
const RELAY_EXPOSED_RESPONSE_HEADERS = "X-Event-Cursor, X-Next-Cursor, X-Max-Event-Ordinal, Server-Timing, X-Claxedo-Trace-Id, X-Claxedo-Relay-Location-Hint"

// Deployment-configured ADDITIVE app origins (CLAXEDO_APP_ORIGINS,
// comma-separated; exact `https://app.example.com` or `https://*.example.com`
// suffix entries). Set once at Worker boot so staged app hosts (e.g.
// Cloudflare Pages) can call the relay without editing shared code per
// deployment.
let configuredAppOriginAllowed: (origin: string) => boolean = () => false

export function setWorkspaceRelayAppOrigins(raw: string | undefined) {
  configuredAppOriginAllowed = raw?.trim()
    ? createOriginMatcher(parseAllowedOrigins(raw) ?? [])
    : () => false
}

// Deployment-configured REPLACEMENT origin allowlist
// (CLAXEDO_RELAY_ALLOWED_ORIGINS). When set, it fully replaces the built-in
// default list (Claxedo/OpenCode app origins plus localhost dev hosts) — a
// self-hosted relay is not forced to keep the product domains in its CORS
// policy. Additive CLAXEDO_APP_ORIGINS entries still apply on top.
const defaultOriginAllowed = createOriginMatcher(DEFAULT_RELAY_APP_ORIGINS)
let baseOriginAllowed = defaultOriginAllowed

export function setWorkspaceRelayAllowedOrigins(raw: string | undefined) {
  const patterns = parseAllowedOrigins(raw)
  baseOriginAllowed = patterns ? createOriginMatcher(patterns) : defaultOriginAllowed
}

function allowedCorsOrigin(origin: string | null): string | undefined {
  if (!origin) return undefined
  return baseOriginAllowed(origin) || configuredAppOriginAllowed(origin) ? origin : undefined
}

/**
 * The browser-origin gate on workspace WebSocket upgrades, applied after token
 * authorization and before the upgrade is granted. A request carrying NO
 * `Origin` header is a non-browser client — browsers always send Origin on
 * WebSocket upgrades — so there is no origin verdict to enforce and it is
 * admitted.
 */
export function workspaceUpgradeOriginDenied(request: Request) {
  const origin = request.headers.get("origin")
  if (origin === null || allowedCorsOrigin(origin)) return null
  return Response.json(errorBody("origin_not_allowed", "Origin is not in the allowlist"), { status: 403 })
}

function corsHeaders(request: Request): Record<string, string> | undefined {
  const origin = allowedCorsOrigin(request.headers.get("origin"))
  if (!origin) return undefined
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": RELAY_ALLOWED_REQUEST_HEADERS,
    "access-control-expose-headers": RELAY_EXPOSED_RESPONSE_HEADERS,
    "access-control-max-age": "86400",
    "timing-allow-origin": origin,
    vary: "Origin",
  }
}

export function corsPreflight(request: Request) {
  const headers = corsHeaders(request)
  return new Response(null, { status: headers ? 204 : 403, ...(headers ? { headers } : {}) })
}

/**
 * Response headers the RELAY — not the upstream — owns at this boundary.
 * Every workspace shares the relay's origin, so an upstream Set-Cookie would
 * be replayed to other workspaces' requests through the relay, and an
 * upstream access-control-* grant would answer for the relay's own allowlist.
 * Stripped unconditionally before `corsHeaders` stamps the relay's policy.
 */
const UPSTREAM_OWNED_RESPONSE_HEADERS = [
  "set-cookie",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-expose-headers",
  "access-control-max-age",
]

export function withCors(request: Request, response: Response) {
  // A WebSocket upgrade (101) CANNOT be reconstructed: in Workers
  // `new Response(..., { status: 101 })` throws and the attached `webSocket`
  // would be dropped anyway. Browsers always send `Origin` on WS upgrades, so
  // wrapping here turned EVERY browser PTY/WS connection into a 500 while
  // non-browser clients (no Origin header) worked — pass upgrades through
  // untouched (WebSockets are not subject to CORS).
  if (response.status === 101 || ("webSocket" in response && response.webSocket)) return response
  const next = new Headers(response.headers)
  for (const name of UPSTREAM_OWNED_RESPONSE_HEADERS) next.delete(name)
  for (const [key, value] of Object.entries(corsHeaders(request) ?? {})) next.set(key, value)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: next,
  })
}
