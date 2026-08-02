// Vendored from arctic@2.3.4 (MIT) — see LICENSE-NOTICE.md.
// Adaptation: @oslojs/encoding + @oslojs/crypto replaced with node:crypto.
import { createHash, randomBytes } from "node:crypto"

export class OAuth2Tokens {
  data: Record<string, unknown>

  constructor(data: Record<string, unknown>) {
    this.data = data
  }

  tokenType(): string {
    if (typeof this.data.token_type === "string") return this.data.token_type
    throw new Error("Missing or invalid 'token_type' field")
  }

  accessToken(): string {
    if (typeof this.data.access_token === "string") return this.data.access_token
    throw new Error("Missing or invalid 'access_token' field")
  }

  accessTokenExpiresInSeconds(): number {
    if (typeof this.data.expires_in === "number") return this.data.expires_in
    throw new Error("Missing or invalid 'expires_in' field")
  }

  hasExpiresIn(): boolean {
    return typeof this.data.expires_in === "number"
  }

  hasRefreshToken(): boolean {
    return typeof this.data.refresh_token === "string"
  }

  refreshToken(): string {
    if (typeof this.data.refresh_token === "string") return this.data.refresh_token
    throw new Error("Missing or invalid 'refresh_token' field")
  }

  hasScopes(): boolean {
    return typeof this.data.scope === "string"
  }

  scopes(): string[] {
    if (typeof this.data.scope === "string") return this.data.scope.split(" ")
    throw new Error("Missing or invalid 'scope' field")
  }

  idToken(): string {
    if (typeof this.data.id_token === "string") return this.data.id_token
    throw new Error("Missing or invalid field 'id_token'")
  }
}

export function createS256CodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url")
}

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url")
}

export function generateState(): string {
  return randomBytes(32).toString("base64url")
}
