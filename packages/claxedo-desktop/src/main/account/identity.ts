/**
 * Account display identity from the authorization server's userinfo endpoint.
 *
 * Electron main owns the access token and never ships it to the renderer, so
 * the only place that can learn the user's name is here — after sign-in / on
 * restore — by calling the OIDC userinfo resource with that token.
 */

import type { AccountIdentity } from "./account-service"

/** Derive Clerk/OIDC userinfo from the registered token endpoint. */
export function userInfoUrlFromTokenUrl(tokenUrl: string): string | undefined {
  const trimmed = tokenUrl.trim()
  if (!trimmed) return undefined
  if (trimmed.endsWith("/oauth/token")) return `${trimmed.slice(0, -"/oauth/token".length)}/oauth/userinfo`
  try {
    return new URL("userinfo", trimmed.endsWith("/") ? trimmed : `${trimmed}/`).href
  } catch {
    return undefined
  }
}

/**
 * Map a userinfo JSON body to the sanitized identity the renderer may see.
 *
 * Accepts the common OIDC claim names plus Clerk's occasional `username`.
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

/** GET userinfo with the access token; never throws — empty identity on failure. */
export function createIdentityResolver(input: {
  userInfoUrl: string
  fetch: typeof fetch
  onError?: (error: unknown) => void
}): ResolveIdentity {
  return async (accessToken) => {
    try {
      const response = await input.fetch(input.userInfoUrl, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      })
      if (!response.ok) throw new Error(`userinfo failed: ${response.status}`)
      return identityFromUserInfo(await response.json())
    } catch (error) {
      input.onError?.(error)
      return { userId: "" }
    }
  }
}

function stringClaim(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}
