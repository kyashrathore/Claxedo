import { Google } from "../vendor/arctic/google.js"
import type { FetchLike } from "../vendor/arctic/request.js"
import type { IntegrationDeclaration, IntegrationImpl, OAuthTokens } from "../types.js"
import { timeoutFetch, type IntegrationFetchOptions } from "./fetch-timeout.js"

/**
 * Adapts the package's `(url, init)` fetch seam to the `(request)` shape the
 * vendored arctic client calls.
 *
 * The client builds a complete `Request` (method, form body, Basic credentials)
 * and hands it to its fetch; hosts inject the same `IntegrationFetch` they give
 * the four key-based impls, so the two shapes meet here. Method, headers, and
 * body survive the unpacking, and `request.signal` is forwarded so the deadline
 * `timeoutFetch` attaches composes with anything the client set rather than
 * replacing it.
 */
function arcticFetch(integrationFetch: (url: string, init?: RequestInit) => Promise<Response>): FetchLike {
  return async (request) => {
    const bodyless = request.method === "GET" || request.method === "HEAD"
    return integrationFetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(bodyless ? {} : { body: await request.arrayBuffer() }),
      signal: request.signal,
    })
  }
}

// The kit reads no env: the HOST supplies client credentials, the redirect
// URI (its public callback route), and the scopes its consumers need.
export function googleIntegration(options: IntegrationFetchOptions & {
  clientId: string
  clientSecret: string
  redirectUri: string
  scopes: string[]
  now?: () => number
}): { decl: IntegrationDeclaration; impl: IntegrationImpl } {
  const now = options.now ?? Date.now
  const client = new Google(
    options.clientId,
    options.clientSecret,
    options.redirectUri,
    arcticFetch(timeoutFetch(options)),
  )

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
