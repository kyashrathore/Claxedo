import type { AccountConfigEnv } from "./account-config"

/** Public OAuth values baked into an official desktop artifact. */
export type BakedAccountConfig = {
  CLAXEDO_ACCOUNT_AUTHORIZE_URL?: string
  CLAXEDO_ACCOUNT_TOKEN_URL?: string
  CLAXEDO_ACCOUNT_CLIENT_ID?: string
  CLAXEDO_ACCOUNT_SCOPE?: string
  CLAXEDO_SERVER_ORIGIN?: string
}

/**
 * Resolve the desktop public-client configuration.
 *
 * A self-built app may override the baked public values at launch. Secrets are
 * intentionally absent: PKCE desktop clients are public clients and must not
 * carry a client secret in either source or the artifact.
 */
export function accountConfigEnvironment(
  runtime: AccountConfigEnv,
  baked: BakedAccountConfig,
): AccountConfigEnv {
  const value = (name: keyof AccountConfigEnv) => runtime[name]?.trim() || baked[name]?.trim() || undefined
  return {
    CLAXEDO_ACCOUNT_AUTHORIZE_URL: value("CLAXEDO_ACCOUNT_AUTHORIZE_URL"),
    CLAXEDO_ACCOUNT_TOKEN_URL: value("CLAXEDO_ACCOUNT_TOKEN_URL"),
    CLAXEDO_ACCOUNT_CLIENT_ID: value("CLAXEDO_ACCOUNT_CLIENT_ID"),
    CLAXEDO_ACCOUNT_SCOPE: value("CLAXEDO_ACCOUNT_SCOPE"),
    CLAXEDO_SERVER_ORIGIN: value("CLAXEDO_SERVER_ORIGIN"),
  }
}
