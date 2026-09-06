/**
 * Account display identity from the authorization server's userinfo endpoint.
 *
 * Electron main owns the access token and never ships it to the renderer, so
 * the only place that can learn the user's name is here — after sign-in / on
 * restore — by calling the OIDC userinfo resource with that token.
 */

import type { AccountIdentity } from "./account-service"
import { trimToUndefined } from "@claxedo/helpers/string"

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
 * The subject is required; display claims are optional. A response without a
 * subject is a failed identity lookup, so the account owner can retry it.
 */

import { asRecord } from "../../shared/json-read"

export function identityFromUserInfo(body: unknown): AccountIdentity {
  const record = asRecord(body)
  if (!record) throw new Error("userinfo omitted its subject")
  const userId = trimToUndefined(record.sub) ?? trimToUndefined(record.user_id)
  if (!userId) throw new Error("userinfo omitted its subject")
  const fromParts = [trimToUndefined(record.given_name), trimToUndefined(record.family_name)]
    .filter((part): part is string => !!part)
    .join(" ")
  const displayName =
    trimToUndefined(record.name) ??
    trimToUndefined(record.preferred_username) ??
    trimToUndefined(record.username) ??
    (fromParts || undefined)
  const email = trimToUndefined(record.email)
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

/** GET canonical userinfo; rejection lets the account owner apply its retry policy. */
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
      return await Promise.race([
        (async () => {
          const response = await input.fetch(input.userInfoUrl, {
            headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
            signal: controller.signal,
          })
          if (!response.ok) throw new Error(`userinfo failed: ${response.status}`)
          return identityFromUserInfo(await response.json())
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            const error = new Error("userinfo timed out")
            controller.abort(error)
            reject(error)
          }, timeoutMs)
        }),
      ])
    } catch (error) {
      input.onError?.(error)
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}

