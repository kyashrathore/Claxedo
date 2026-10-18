import type { Context, MiddlewareHandler } from "hono"

import type { BrowserAuthDescriptor } from "@claxedo/account-contract/auth"

function trustedRequestOrigin(request: Request, browser: BrowserAuthDescriptor) {
  const origin = request.headers.get("origin")
  return origin && browser.trustedOrigins.includes(origin) ? origin : undefined
}

function reject(context: Context, status: 403 | 415, code: string, message: string) {
  return context.json({ error: { code, message } }, status)
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
  const mediaType = raw.split(";", 1)[0].trim().toLowerCase()
  return mediaType === "application/json" || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType)
}

/**
 * The cookie transport's CSRF policy, selected by the statically composed
 * auth adapter: a mutation carrying the session cookie must come from the
 * trusted origin, as a same-origin fetch, with a JSON body. The browser app
 * shares the control plane's origin, so none of its own requests is
 * cross-origin and no origin is granted CORS. Bearer transports keep their
 * own non-cookie request posture.
 */
export function browserAuthHttpSecurity(browser: BrowserAuthDescriptor): MiddlewareHandler {
  return async (context, next) => {
    if (browser.transport !== "cookie") return next()
    const cookieAuthenticatedMutation =
      isUnsafeMethod(context.req.method) && requestHasExactCookie(context.req.raw, browser.cookie.name)
    if (!cookieAuthenticatedMutation) return next()
    if (!trustedRequestOrigin(context.req.raw, browser)) {
      return reject(context, 403, "browser_auth_origin_forbidden", "Cookie-authenticated browser requests require an exact trusted Origin")
    }
    if (context.req.header("sec-fetch-site")?.trim().toLowerCase() === "cross-site") {
      return reject(context, 403, "browser_auth_cross_site_forbidden", "Cookie-authenticated browser mutations cannot be cross-site")
    }
    if (!hasSupportedMutationContentType(context.req.raw)) {
      return reject(context, 415, "browser_auth_content_type_unsupported", "Cookie-authenticated browser mutations require a JSON content type")
    }
    return next()
  }
}
