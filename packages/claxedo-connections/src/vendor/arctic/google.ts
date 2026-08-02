// Vendored from arctic@2.3.4 (MIT) — see LICENSE-NOTICE.md.
// Adaptation: inlined the OAuth2Client PKCE code paths Google uses;
// injectable fetch for tests.
import { createS256CodeChallenge, OAuth2Tokens } from "./oauth2.js"
import { createOAuth2Request, encodeBasicCredentials, sendTokenRequest, sendTokenRevocationRequest, type FetchLike } from "./request.js"

const authorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth"
const tokenEndpoint = "https://oauth2.googleapis.com/token"
const tokenRevocationEndpoint = "https://oauth2.googleapis.com/revoke"

export class Google {
  private clientId: string
  private clientSecret: string
  private redirectURI: string
  private fetchImpl: FetchLike

  constructor(clientId: string, clientSecret: string, redirectURI: string, fetchImpl: FetchLike = fetch) {
    this.clientId = clientId
    this.clientSecret = clientSecret
    this.redirectURI = redirectURI
    this.fetchImpl = fetchImpl
  }

  createAuthorizationURL(state: string, codeVerifier: string, scopes: string[]): URL {
    const url = new URL(authorizationEndpoint)
    url.searchParams.set("response_type", "code")
    url.searchParams.set("client_id", this.clientId)
    url.searchParams.set("redirect_uri", this.redirectURI)
    url.searchParams.set("state", state)
    url.searchParams.set("code_challenge_method", "S256")
    url.searchParams.set("code_challenge", createS256CodeChallenge(codeVerifier))
    if (scopes.length > 0) url.searchParams.set("scope", scopes.join(" "))
    return url
  }

  async validateAuthorizationCode(code: string, codeVerifier: string): Promise<OAuth2Tokens> {
    const body = new URLSearchParams()
    body.set("grant_type", "authorization_code")
    body.set("code", code)
    body.set("redirect_uri", this.redirectURI)
    body.set("code_verifier", codeVerifier)
    const request = createOAuth2Request(tokenEndpoint, body)
    request.headers.set("Authorization", `Basic ${encodeBasicCredentials(this.clientId, this.clientSecret)}`)
    return await sendTokenRequest(request, this.fetchImpl)
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuth2Tokens> {
    const body = new URLSearchParams()
    body.set("grant_type", "refresh_token")
    body.set("refresh_token", refreshToken)
    const request = createOAuth2Request(tokenEndpoint, body)
    request.headers.set("Authorization", `Basic ${encodeBasicCredentials(this.clientId, this.clientSecret)}`)
    return await sendTokenRequest(request, this.fetchImpl)
  }

  async revokeToken(token: string): Promise<void> {
    const body = new URLSearchParams()
    body.set("token", token)
    const request = createOAuth2Request(tokenRevocationEndpoint, body)
    request.headers.set("Authorization", `Basic ${encodeBasicCredentials(this.clientId, this.clientSecret)}`)
    await sendTokenRevocationRequest(request, this.fetchImpl)
  }
}
