/**
 * Account display identity from the authorization server's userinfo endpoint.
 *
 * Electron main owns the access token and never ships it to the renderer, so
 * the only place that can learn the user's name is here — after sign-in / on
 * restore — by calling the OIDC userinfo resource with that token.
 */

import type { AccountIdentity } from "./account-service"

/** Derive OIDC userinfo from the registered token endpoint. */
export function userInfoUrlFromTokenUrl(tokenUrl: string): string | undefined {
  const trimmed = tokenUrl.trim()
  if (!trimmed) return undefined
  if (trimmed.endsWith("/oauth/token")) return `${trimmed.slice(0, -"/oauth/token".length)}/oauth/userinfo`
  // Better Auth serves its userinfo as a sibling of the token route. The
  // generic relative-resolution below would yield `/oauth2/token/userinfo`,
  // a 404 whose swallowed failure left every desktop identity as
  // `{ userId: "" }` against Better Auth deployments.
  if (trimmed.endsWith("/oauth2/token")) return `${trimmed.slice(0, -"/token".length)}/userinfo`
  try {
    return new URL("userinfo", trimmed.endsWith("/") ? trimmed : `${trimmed}/`).href
  } catch {
    return undefined
  }
}

/**
 * Map a userinfo JSON body to the sanitized identity the renderer may see.
 *
 * Accepts the common OIDC claim names plus the occasional provider `username`.
 * Unknown shapes still produce a usable `{ userId }` so sign-in is not blocked
 * by a profile that is merely incomplete.
 */
export function identityFromUserInfo(body: unknown): AccountIdentity {
  if (!body || typeof body !== "object") return { userId: "" }
  const record = body as Record<string, unknown>
  const userId = stringClaim(record.sub) ?? stringClaim(record.user_id) ?? ""
  const fromParts = [stringClaim(record.given_name), stringClaim(record.family_name)]
    .filter((part): part is string => !!part)
    .join(" ")
  const displayName =
    stringClaim(record.name) ??
    stringClaim(record.preferred_username) ??
    stringClaim(record.username) ??
    (fromParts || undefined)
  const email = stringClaim(record.email)
  return {
    userId,
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
  }
}

export type ResolveIdentity = (accessToken: string) => Promise<AccountIdentity>

/**
 * Wide enough for an edge that stalls, because nothing waits on this.
 *
 * Identity is best-effort enrichment resolved off the sign-in path, so the
 * only thing a short budget buys is a nameless account. Five seconds lost
 * that race repeatedly on this deployment — `[account] identity: Error:
 * userinfo timed out` on relaunch after relaunch, while the endpoint itself
 * answered in well under a second when asked directly. The Cloudflare edge
 * can withhold a response on a warm connection for around twelve seconds
 * (see `reference_cf_edge_get_then_post_stall`), which is simply longer than
 * the budget it was given.
 */
const USERINFO_TIMEOUT_MS = 20_000

/** GET userinfo with the access token; never throws — empty identity on failure. */
export function createIdentityResolver(input: {
  userInfoUrl: string
  fetch: typeof fetch
  onError?: (error: unknown) => void
  /** Kept injectable so the bounded-failure behavior is testable. */
  timeoutMs?: number
}): ResolveIdentity {
  return async (accessToken) => {
    const controller = new AbortController()
    const timeoutMs = Math.max(1, input.timeoutMs ?? USERINFO_TIMEOUT_MS)
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await Promise.race([
        input.fetch(input.userInfoUrl, {
          headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            const error = new Error("userinfo timed out")
            controller.abort(error)
            reject(error)
          }, timeoutMs)
        }),
      ])
      if (!response.ok) throw new Error(`userinfo failed: ${response.status}`)
      return identityFromUserInfo(await response.json())
    } catch (error) {
      input.onError?.(error)
      return { userId: "" }
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}

function stringClaim(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}
