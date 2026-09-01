import type { Context, MiddlewareHandler } from "hono"

import type { BrowserAuthDescriptor } from "../auth/authentication"

/**
 * Request headers a browser on a DIFFERENT origin may send to this server.
 *
 * A cross-origin request carrying a header that is not named here is never
 * sent: the browser asks first, compares the answer, and drops the request
 * itself. Nothing reaches this server, so nothing is logged, and the server
 * looks perfectly healthy while the app is dead — which is exactly how the
 * omission below survived. The hosted app showed "Workspace host is offline"
 * with a fully working relay, a live host tunnel, and a laptop answering every
 * request that was actually delivered to it.
 *
 * `last-event-id` is what made that concrete. `EventSource`, and every SSE
 * client that resumes a stream, sends it on RECONNECT — so the first
 * connection succeeded and every recovery after it was refused by the browser.
 * A list that omits it does not break the event stream, it breaks the event
 * stream's ability to heal, which is far harder to see.
 *
 * Add a header here when a browser client starts sending it. The pin in
 * `browser-auth-security.test.ts` states what the client sends today.
 */
export const BROWSER_ALLOWED_REQUEST_HEADERS = [
  "content-type",
  "last-event-id",
  // W3C Trace Context. Named here BEFORE anything sends it: a trace header the
  // preflight omits does not degrade tracing, it kills the request carrying it,
  // so instrumentation would take the product down. `@claxedo/telemetry`
  // explains the propagation these two carry.
  "traceparent",
  "tracestate",
  "x-claxedo-bootstrap-owner-claim",
  "x-claxedo-multiplayer-validation-operation",
] as const

function trustedRequestOrigin(request: Request, browser: BrowserAuthDescriptor) {
  const origin = request.headers.get("origin")
  return origin && browser.trustedOrigins.includes(origin) ? origin : undefined
}

function appendVaryOrigin(context: Context) {
  const values = (context.res.headers.get("vary") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  if (!values.some((value) => value.toLowerCase() === "origin")) values.push("Origin")
  context.header("vary", values.join(", "))
}

function stampCredentialedCors(context: Context, origin: string) {
  context.header("access-control-allow-origin", origin)
  context.header("access-control-allow-credentials", "true")
  // Lets the app read this response's resource timing (connect, TLS,
  // request, response, protocol) instead of a single masked duration — the
  // evidence that says WHERE a slow or hung request spent its time.
  context.header("timing-allow-origin", origin)
  appendVaryOrigin(context)
}

function reject(context: Context, status: 403 | 415, code: string, message: string, origin?: string) {
  if (origin) stampCredentialedCors(context, origin)
  else appendVaryOrigin(context)
  return context.json(
    {
      error: {
        code,
        message,
      },
    },
    status,
  )
}

function originForbidden(context: Context) {
  return reject(
    context,
    403,
    "browser_auth_origin_forbidden",
    "Cookie-authenticated browser requests require an exact trusted Origin",
  )
}

function isCorsPreflight(request: Request) {
  return request.method === "OPTIONS" && request.headers.has("access-control-request-method")
}

function isUnsafeMethod(method: string) {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS"
}

function requestHasExactCookie(request: Request, name: string) {
  return (request.headers.get("cookie") ?? "").split(";").some((part) => {
    const cookie = part.trim()
    const separator = cookie.indexOf("=")
    return separator >= 0 && cookie.slice(0, separator).trim() === name
  })
}

function hasSupportedMutationContentType(request: Request) {
  const raw = request.headers.get("content-type")
  if (!raw) return request.body === null
  const mediaType = raw.split(";", 1)[0]!.trim().toLowerCase()
  return mediaType === "application/json" || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType)
}

/**
 * Browser-transport HTTP policy selected by the statically composed auth
 * adapter. Cookie transports receive exact-origin credentialed CORS and
 * application-route CSRF protection. Bearer
 * transports deliberately retain their own non-cookie request posture.
 */
export function browserAuthHttpSecurity(browser: BrowserAuthDescriptor): MiddlewareHandler {
  return async (context, next) => {
    if (browser.transport !== "cookie") return next()
    const origin = trustedRequestOrigin(context.req.raw, browser)
    if (isCorsPreflight(context.req.raw)) {
      if (!origin) return originForbidden(context)
      stampCredentialedCors(context, origin)
      context.header("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS")
      context.header("access-control-allow-headers", BROWSER_ALLOWED_REQUEST_HEADERS.join(", "))
      return context.body(null, 204)
    }
    const cookieAuthenticatedMutation =
      isUnsafeMethod(context.req.method) && requestHasExactCookie(context.req.raw, browser.cookie.name)
    if (cookieAuthenticatedMutation) {
      if (!origin) return originForbidden(context)
      if (context.req.header("sec-fetch-site")?.trim().toLowerCase() === "cross-site") {
        return reject(
          context,
          403,
          "browser_auth_cross_site_forbidden",
          "Cookie-authenticated browser mutations cannot be cross-site",
          origin,
        )
      }
      if (!hasSupportedMutationContentType(context.req.raw)) {
        return reject(
          context,
          415,
          "browser_auth_content_type_unsupported",
          "Cookie-authenticated browser mutations require a JSON content type",
          origin,
        )
      }
    }
    await next()
    appendVaryOrigin(context)
    if (origin) stampCredentialedCors(context, origin)
  }
}
