/** Better Auth names its session cookie `__Secure-<prefix>.session_token` when `useSecureCookies` is on. */
export const BETTER_AUTH_COOKIE_PREFIX = "claxedo"
export const BETTER_AUTH_SESSION_COOKIE = `__Secure-${BETTER_AUTH_COOKIE_PREFIX}.session_token`

/** Whether a request's Cookie header carries a session token, which says nothing about the token's validity. */
export function carriesSessionCookie(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false
  return cookieHeader.split(";").some((pair) => {
    const separator = pair.indexOf("=")
    return separator > 0 && pair.slice(0, separator).trim() === BETTER_AUTH_SESSION_COOKIE && pair.slice(separator + 1).trim() !== ""
  })
}
