export function loginOAuthContinuation(input: {
  appOrigin: string
  apiOrigin: string
  pathname: string
  search: string
}) {
  if (input.pathname !== "/login" || !input.search) return undefined
  const query = new URLSearchParams(input.search)
  if (
    query.get("response_type") !== "code" ||
    !query.get("client_id") ||
    !query.get("redirect_uri") ||
    !query.get("state")
  ) return undefined

  const login = new URL(input.pathname, input.appOrigin)
  login.search = input.search
  const authorize = new URL("/api/auth/oauth2/authorize", input.apiOrigin)
  authorize.search = input.search
  return {
    signInRedirect: `${login.pathname}${login.search}`,
    authorizationUrl: authorize.toString(),
  }
}
