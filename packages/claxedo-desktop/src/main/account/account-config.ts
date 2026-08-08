/**
 * The OAuth client configuration, read from the environment.
 *
 * Its own module rather than part of the Electron assembly beside it: this has
 * no electron dependency, and keeping it here is what lets it be tested at all.
 *
 * The client is registered by the release owner in the identity provider, not
 * by this code, so its absence is a normal state for a development build and
 * has to be reported rather than crashed on.
 */

export type AccountConfigEnv = {
  CLAXEDO_ACCOUNT_AUTHORIZE_URL?: string
  CLAXEDO_ACCOUNT_TOKEN_URL?: string
  CLAXEDO_ACCOUNT_CLIENT_ID?: string
  CLAXEDO_ACCOUNT_SCOPE?: string
  CLAXEDO_SERVER_ORIGIN?: string
}

/**
 * The scopes a desktop sign-in asks for by default.
 *
 * `offline_access` is the load-bearing one. It is what asks the authorization
 * server for a refresh token, and without a refresh token the account service
 * has nothing to renew with — it signs the user out the moment the access token
 * expires, which for a typical one-hour token means signing in again every
 * session. The desktop is a long-lived app the user leaves open; it is exactly
 * the client OIDC defines this scope for.
 *
 * A provider that does not recognise it will answer `invalid_scope`. That is
 * why `CLAXEDO_ACCOUNT_SCOPE` exists: the release owner who registered the
 * client overrides this wholesale, and gets a session that lasts one token.
 */
export const DEFAULT_SCOPE = "openid profile email offline_access"

export type AccountConfig =
  | { configured: true; authorizeUrl: string; tokenUrl: string; clientId: string; scope: string; serverOrigin: string }
  | { configured: false; missing: string[] }

/**
 * Read the OAuth client configuration.
 *
 * Reports WHICH values are missing rather than a bare false: this is the error
 * a release owner sees when a build ships without its client registered, and
 * "sign-in is unavailable" with no further detail is a support thread.
 */
export function readAccountConfig(env: AccountConfigEnv): AccountConfig {
  const required = {
    authorizeUrl: env.CLAXEDO_ACCOUNT_AUTHORIZE_URL?.trim(),
    tokenUrl: env.CLAXEDO_ACCOUNT_TOKEN_URL?.trim(),
    clientId: env.CLAXEDO_ACCOUNT_CLIENT_ID?.trim(),
    serverOrigin: env.CLAXEDO_SERVER_ORIGIN?.trim(),
  }
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key)
  if (missing.length) return { configured: false, missing }
  return {
    configured: true,
    authorizeUrl: required.authorizeUrl!,
    tokenUrl: required.tokenUrl!,
    clientId: required.clientId!,
    scope: env.CLAXEDO_ACCOUNT_SCOPE?.trim() || DEFAULT_SCOPE,
    serverOrigin: required.serverOrigin!,
  }
}
