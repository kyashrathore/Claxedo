/**
 * Response security headers for the hosted control plane.
 *
 * Mounted as the OUTERMOST middleware in `hosted-app.ts` (ahead of CORS), so
 * every hosted response — routed, CORS-preflighted, 404, or thrown-and-handled
 * by `onError` — carries them and no future route can forget to opt in. The
 * one hosted response that never enters the Hono app is the fail-closed 503
 * from `worker.ts`'s composition guard; that path stamps the same set by hand
 * (see `securityHeaderEntries` usage there).
 *
 * ## Why the CSP here is ENFORCING
 *
 * This app serves ONLY JSON and SSE. There is no `c.html(...)`, no
 * `text/html`, and no static-asset mount anywhere in the hosted route set —
 * the SolidJS SPA is a completely separate deploy target (Cloudflare Pages,
 * `wrangler pages deploy` in `.github/workflows/deploy-claxedo-app.yml`) and
 * never passes through this Worker. A JSON body loads no scripts, styles,
 * fonts, images or frames, so `default-src 'none'` denies exactly nothing the
 * API needs while removing the whole "attacker gets a control-plane response
 * rendered as a document" class (content-sniffed HTML, a 404 body echoed into
 * a page, an SSE stream opened as a top-level navigation).
 *
 * The SPA's CSP is a different, much riskier policy and lives on the Pages
 * surface in `packages/claxedo-app/public/_headers`, where it ships
 * report-only. Keep the two in mind as separate problems: this one is safe to
 * enforce precisely because it protects a surface with no document.
 *
 * ## Why HSTS is conditional
 *
 * `Strict-Transport-Security` pins a HOST, not a URL. Emitting it from a
 * plaintext local control plane (`http://localhost:3001`, the self-host and
 * desktop default) would tell the developer's browser to force HTTPS on
 * `localhost` for a year, breaking every other plaintext dev server on that
 * machine with no obvious cause. Browsers are specified to ignore HSTS
 * received over non-secure transport, but "the browser probably ignores it"
 * is not a guard — `requestIsHttps` is.
 */

import type { Context, MiddlewareHandler } from "hono"

/** One year, the conventional floor for a production HSTS pin. */
export const HSTS_MAX_AGE_SECONDS = 31_536_000

export const HSTS_VALUE = `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`

/**
 * The API lockdown policy. Enforcing, not report-only — see the module note.
 *
 * `default-src 'none'` already covers every fetch directive, but
 * `frame-ancestors`, `base-uri` and `form-action` do NOT fall back to
 * `default-src`, so each is spelled out. `frame-ancestors 'none'` is the
 * modern half of the clickjacking pair whose legacy half is `X-Frame-Options`
 * below.
 */
export const API_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ")

/**
 * Headers that are correct for every hosted response regardless of transport.
 *
 * `Referrer-Policy` is `strict-origin-when-cross-origin` rather than the
 * tighter `no-referrer` so that same-origin navigation keeps its full path —
 * cross-origin requests still leak nothing beyond the origin, and no
 * control-plane URL carries a secret in its path or query today.
 */
export const TRANSPORT_NEUTRAL_SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["content-security-policy", API_CONTENT_SECURITY_POLICY],
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
]

/** The full header set for one response. HSTS is appended only over HTTPS. */
export function securityHeaderEntries(input: { https: boolean }): ReadonlyArray<readonly [string, string]> {
  return input.https
    ? [...TRANSPORT_NEUTRAL_SECURITY_HEADERS, ["strict-transport-security", HSTS_VALUE] as const]
    : TRANSPORT_NEUTRAL_SECURITY_HEADERS
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1"
}

/**
 * Did the BROWSER speak HTTPS to us?
 *
 * On the Cloudflare Worker the request URL is the client-facing URL, so the
 * protocol is authoritative. The Node container deploy (`hosted-node.ts`) can
 * sit behind a TLS-terminating proxy that forwards plaintext, hence the
 * `x-forwarded-proto` fallback — but that header is client-settable, so it is
 * refused for loopback hosts. That is the exact case where a spoofed hint
 * would poison a developer's browser for `localhost`.
 */
export function requestIsHttps(request: { url: string; header: (name: string) => string | undefined }): boolean {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return false
  }
  if (url.protocol === "https:") return true
  if (isLoopbackHost(url.hostname)) return false
  const forwarded = request.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase()
  return forwarded === "https"
}

/**
 * Stamp `entries` onto `response`, returning the response to serve.
 *
 * Usually this mutates in place. A `Response` that came straight out of
 * `fetch()` has an immutable header guard on the Workers runtime, so the
 * fallback rebuilds it — same body stream, same status, same existing headers.
 */
export function withSecurityHeaders(
  response: Response,
  entries: ReadonlyArray<readonly [string, string]>,
): Response {
  try {
    for (const [name, value] of entries) response.headers.set(name, value)
    return response
  } catch {
    const rebuilt = new Response(response.body, response)
    for (const [name, value] of entries) rebuilt.headers.set(name, value)
    return rebuilt
  }
}

/**
 * Outermost hosted middleware.
 *
 * The header write happens AFTER `next()`. Hono's `compose` handles a thrown
 * route inside the innermost `dispatch` frame — `onError` runs there and the
 * result is assigned to `context.res` — so `await next()` returns normally and
 * error responses get stamped too. That is deliberate: a 500 that omits
 * `nosniff` is exactly the response an attacker wants echoed into a document.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c: Context, next) => {
    await next()
    const entries = securityHeaderEntries({ https: requestIsHttps(c.req) })
    const stamped = withSecurityHeaders(c.res, entries)
    // Assigning is only needed when the immutable-headers fallback produced a
    // new Response; Hono's `res` setter merges the previous headers back on
    // top, which is harmless here because the previous response is exactly the
    // one that lacked these headers.
    if (stamped !== c.res) c.res = stamped
  }
}
