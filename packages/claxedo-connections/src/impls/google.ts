import { Google } from "../vendor/arctic/google.js"
import type { FetchLike } from "../vendor/arctic/request.js"
import type { IntegrationDeclaration, IntegrationImpl, OAuthTokens } from "../types.js"

// The kit reads no env: the HOST supplies client credentials, the redirect
// URI (its public callback route), and the scopes its consumers need.
export function googleIntegration(options: {
  clientId: string
  clientSecret: string
  redirectUri: string
  scopes: string[]
  now?: () => number
  fetchImpl?: FetchLike
}): { decl: IntegrationDeclaration; impl: IntegrationImpl } {
  const now = options.now ?? Date.now
  const client = new Google(options.clientId, options.clientSecret, options.redirectUri, options.fetchImpl)

  const toTokens = (tokens: {
    accessToken(): string
    hasRefreshToken(): boolean
    refreshToken(): string
    hasExpiresIn(): boolean
    accessTokenExpiresInSeconds(): number
  }): OAuthTokens => ({
    accessToken: tokens.accessToken(),
    ...(tokens.hasRefreshToken() ? { refreshToken: tokens.refreshToken() } : {}),
    ...(tokens.hasExpiresIn() ? { expiresAt: now() + tokens.accessTokenExpiresInSeconds() * 1000 } : {}),
  })

  return {
    decl: {
      id: "google",
      name: "Google",
      methods: ["oauth"],
      capabilities: ["docs"],
    },
    impl: {
      authorize(state, codeVerifier) {
        const url = client.createAuthorizationURL(state, codeVerifier, options.scopes)
        // Google only issues refresh tokens with these two parameters.
        url.searchParams.set("access_type", "offline")
        url.searchParams.set("prompt", "consent")
        return url
      },
      async callback(code, codeVerifier) {
        return toTokens(await client.validateAuthorizationCode(code, codeVerifier))
      },
      async refresh(refreshToken) {
        return toTokens(await client.refreshAccessToken(refreshToken))
      },
    },
  }
}
