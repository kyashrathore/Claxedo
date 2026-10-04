export const BETTER_AUTH_ACCESS_TOKEN_PREFIX = "clx_at_"
export const BETTER_AUTH_REFRESH_TOKEN_PREFIX = "clx_rt_"

function base64Url(bytes: Uint8Array) {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

/**
 * Canonical Better Auth OAuth token hash used by both issuance and the D1
 * verifier. Raw native credentials must never be persisted.
 */
export async function betterAuthOAuthTokenHash(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  return base64Url(new Uint8Array(digest))
}
