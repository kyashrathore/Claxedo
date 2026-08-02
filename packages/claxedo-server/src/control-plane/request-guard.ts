/**
 * The hosted control plane's DEFAULT request guard: one Hono middleware that
 * gives every mounted route a body cap and an abuse rate limit unless the route
 * is explicitly, namedly exempted (W3.2).
 *
 * ## Why default-on rather than per-route
 *
 * The pre-W3 posture was opt-in, and the result is the finding this fixes: nine
 * routes threaded a limiter and roughly fifty did not — `/api/workgraph/*`, the
 * documents routes, and checkpoint/lifecycle (including destroy) had nothing at
 * all. Opt-in security is a per-route review item that fails silently the first
 * time someone forgets. Mounted here, once, at composition, "no hosted route
 * ships without a body cap" becomes a property of the shell — the same argument
 * `securityHeaders()` makes one middleware above this one (see hosted-app.ts).
 *
 * Exemptions are therefore DATA, not absence: a route escapes the default only
 * by appearing in the exemption registry with a reason and the file that enforces
 * the replacement. `route-guard-inventory.test.ts` reads that registry and fails
 * both ways — an unexempted route that accepts an oversized body, and a stale
 * exemption matching no mounted route (a renamed path would otherwise leave a
 * permanent silent hole).
 *
 * The registry is SPLIT rather than central, and that is deliberate. This module
 * lives in the storage- and vendor-agnostic control-plane core, which
 * `billing-architecture.test.ts` keeps free of payment-vendor tokens (R8). A
 * feature whose exemption requires naming a vendor therefore exports its own
 * entry from its own module (see `billing/billing-routes.ts`
 * `BILLING_WEBHOOK_GUARD_EXEMPTION`), and `hosted-app.ts` composes the full list
 * via `hostedRouteGuardExemptions()`. The composition — not this constant — is
 * what the inventory test asserts against.
 *
 * ## Strangler posture
 *
 * This is additive. The nine routes that already thread
 * `createFixedWindowConnectionRateLimiter` keep their own limiters untouched and
 * unchanged — their budgets are tuned per surface (6/min for connections,
 * 120/min for control-plane, 30/min for device login, 20/min for billing) and
 * several depend on `refund()` and `firstRejection` semantics this layer does
 * not model. The default limit sits ABOVE all of them as a coarse ceiling, so a
 * request must satisfy both: effectively the stricter of the two, never the sum.
 * No correctly-limited route changes behavior.
 */

import { bodyLimit } from "hono/body-limit"
import type { Context, MiddlewareHandler } from "hono"
import type { LayeredRateLimiter } from "./rate-limit"

/**
 * Default maximum request body, 1 MiB.
 *
 * Chosen below documents' hand-rolled 2 MiB (`routes/documents.ts`
 * MAX_BODY_BYTES) on purpose: documents is the one surface with a demonstrated
 * need for large bodies, and it is exempted below so its own cap governs. Every
 * other hosted route takes JSON control payloads measured in kilobytes, so 1 MiB
 * is roughly three orders of magnitude of headroom over real traffic while still
 * bounding what one request can make the Worker buffer.
 */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

/** Default ceiling: requests per minute per client, above every route limiter. */
export const DEFAULT_RATE_LIMIT = 600

export type RouteGuardExemption = {
  /**
   * Path PREFIX this exemption covers, matched against the mounted route path.
   * A prefix (not a regex) so the registry stays greppable and an exemption
   * cannot accidentally widen to unrelated routes.
   */
  prefix: string
  /** Exempt from the default body cap. Requires `enforcedBy`. */
  bodyCap?: boolean
  /** Exempt from the default rate limit. Requires `enforcedBy`. */
  rateLimit?: boolean
  /** Why this route cannot take the default. Read by humans and the test. */
  reason: string
  /** Where the replacement protection lives. The test asserts it is non-empty. */
  enforcedBy: string
}

/**
 * Core hosted routes that do not take a default guard.
 *
 * Adding an entry is the only way to skip the default, and every entry costs a
 * reason plus the file that protects the route instead. Keep it short — a growing
 * list is the signal that the default is wrong, not that the routes are special.
 *
 * Feature-owned exemptions that would name a vendor here live with their feature
 * and are merged by `hostedRouteGuardExemptions()`; see the module header.
 */
export const CORE_ROUTE_GUARD_EXEMPTIONS: readonly RouteGuardExemption[] = [
  {
    prefix: "/documents",
    bodyCap: true,
    reason:
      "Documents carry markdown bodies that legitimately exceed the 1 MiB default; the surface has enforced its own 2 MiB cap since D11 and that cap is the reviewed number.",
    enforcedBy: "src/routes/documents.ts (MAX_BODY_BYTES, enforced on create and update)",
  },
  {
    prefix: "/api/claxedo/events",
    bodyCap: true,
    reason:
      "Long-lived SSE stream: a GET with no request body, held open for the session. A body cap is meaningless and the streaming response must not be wrapped.",
    enforcedBy: "src/routes/hosted-shell.ts (auth-gated; connection count bounded by src/live-sync-room.ts)",
  },
  {
    prefix: "/api/wr/events",
    bodyCap: true,
    reason: "SSE alias of /api/claxedo/events — same stream, same reasoning.",
    enforcedBy: "src/routes/hosted-shell.ts (auth-gated; connection count bounded by src/live-sync-room.ts)",
  },
  {
    prefix: "/global/event",
    bodyCap: true,
    reason: "SSE alias of /api/claxedo/events — same stream, same reasoning.",
    enforcedBy: "src/routes/hosted-shell.ts (auth-gated; connection count bounded by src/live-sync-room.ts)",
  },
]

/**
 * Every exemption the hosted app honors: the core list plus each
 * feature-contributed entry.
 *
 * A function rather than a constant so feature modules can be imported here
 * without this module importing them in the other direction — the whole point of
 * the split (see the module header). Callers pass the result to
 * `defaultRequestGuard`; `route-guard-inventory.test.ts` asserts against it.
 */
export function hostedRouteGuardExemptions(
  featureExemptions: readonly RouteGuardExemption[] = [],
): readonly RouteGuardExemption[] {
  return [...CORE_ROUTE_GUARD_EXEMPTIONS, ...featureExemptions]
}

/** Does an exemption cover this path for the given guard? */
export function guardExemptionFor(
  path: string,
  guard: "bodyCap" | "rateLimit",
  exemptions: readonly RouteGuardExemption[] = CORE_ROUTE_GUARD_EXEMPTIONS,
) {
  return exemptions.find((entry) => entry[guard] === true && pathMatchesPrefix(path, entry.prefix))
}

/**
 * Prefix match on path SEGMENTS, so `/documents` cannot exempt
 * `/documents-admin` while still covering `/documents/:id/versions`.
 */
export function pathMatchesPrefix(path: string, prefix: string) {
  if (path === prefix) return true
  if (!path.startsWith(prefix)) return false
  const next = path.charAt(prefix.length)
  return next === "/" || next === ""
}

/**
 * Client identity for the default limiter.
 *
 * IP-KEYED, DELIBERATELY — not per-principal. Keying on a principal would mean
 * reading identity from the request before any route has verified it, and an
 * UNVERIFIED subject is attacker-supplied: anyone could reach a fresh bucket by
 * varying a claim or sending a new garbage token, which turns the limiter into
 * decoration. Verifying the JWT here instead would put a Clerk JWKS check on
 * the front of every request including unauthenticated ones — an amplification
 * vector of its own.
 *
 * So the layering is: this middleware bounds per-CLIENT abuse on a stable
 * network identity, and per-PRINCIPAL budgets stay with the nine route-level
 * limiters, which run after auth and therefore key on a verified subject. Same
 * rule `@claxedo/channels` states for its own limiter: abuse accounting keys on
 * stable principals only.
 *
 * `cf-connecting-ip` is Cloudflare's own header and cannot be spoofed by a
 * client on the Worker path; `x-forwarded-for`'s first entry is the fallback for
 * the Node container behind a proxy. Same derivation as
 * `routes/hosted-device-auth.ts` `rateLimitClientKey`.
 */
export function requestClientKey(c: Context) {
  const direct = c.req.header("cf-connecting-ip")?.trim()
  if (direct) return direct
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
  if (forwarded) return forwarded
  return "anonymous"
}

export type RequestGuardOptions = {
  /** Cross-isolate ceiling. Omitted → no default rate limit is applied. */
  rateLimiter?: LayeredRateLimiter
  maxBodyBytes?: number
  exemptions?: readonly RouteGuardExemption[]
}

/**
 * The default guard, mounted once in `hosted-app.ts`.
 *
 * Order inside: rate limit BEFORE body cap. A rejected client should be turned
 * away without the Worker reading or buffering a byte of its body — doing the
 * cap first would make the expensive check the one a flood always pays for.
 *
 * Both layers consult the exemption registry by the REQUEST path (`c.req.path`)
 * rather than the matched route pattern, because middleware runs before routing
 * resolves a pattern. `pathMatchesPrefix` is segment-aware so this cannot
 * over-match.
 */
export function defaultRequestGuard(options: RequestGuardOptions = {}): MiddlewareHandler {
  const maxSize = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const exemptions = options.exemptions ?? CORE_ROUTE_GUARD_EXEMPTIONS
  const rateLimiter = options.rateLimiter
  const capMiddleware = bodyLimit({
    maxSize,
    onError: (c) =>
      c.json(
        {
          error: {
            code: "request_body_too_large",
            message: `Request body exceeds the ${maxSize}-byte limit`,
          },
        },
        413,
      ),
  })

  return async (c, next) => {
    const path = c.req.path

    if (rateLimiter && !guardExemptionFor(path, "rateLimit", exemptions)) {
      const result = await rateLimiter.check({ key: requestClientKey(c) })
      if (!result.allowed) {
        return c.json(
          {
            error: {
              code: "rate_limited",
              message: "Request limit exceeded",
              retryAfterMs: result.retryAfterMs,
            },
          },
          429,
          { "retry-after": String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))) },
        )
      }
    }

    if (guardExemptionFor(path, "bodyCap", exemptions)) return next()
    return capMiddleware(c, next)
  }
}
