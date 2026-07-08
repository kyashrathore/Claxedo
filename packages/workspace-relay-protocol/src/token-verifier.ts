/**
 * Unified token-verifier interface (P-shared).
 *
 * Each of the four Claxedo boundaries (relay/tunnel, agent extension,
 * SDK runner, workspace host) historically defined its own ad-hoc
 * verifier shape. This module is the single seam every downstream user
 * can swap a custom implementation through.
 *
 * The interface is intentionally narrow: token in, claims out. It does
 * not expose JWKS plumbing, audience-binding sugar, or replay-cache
 * details — those belong to the impl, not the contract.
 *
 * See the boundary READMEs for wiring rules.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose"

export type TokenVerifierBaseClaims = {
  iss: string
  aud: string
  sub: string
  workspace_id: string
  host_id: string
  exp: number
  iat: number
  jti: string
} & Record<string, unknown>

export type RuntimeAccessVerifierClaims = TokenVerifierBaseClaims & {
  org_id: string
  role: "viewer" | "editor" | "admin" | "owner"
}

export type RelayHostVerifierClaims = TokenVerifierBaseClaims & {
  org_id: string
} & (
  | { access: "cloud"; backing: "cloud-vm" }
  | { access: "user-hosted"; backing: "local-worktree" }
)

export type TokenClaims<TClaims extends Record<string, unknown> = Record<string, unknown>> = {
  /** Stable subject id. The boundary is responsible for mapping this
   *  to a domain principal (user, workspace, runtime, etc.). */
  subject: string
  /** Scopes / capabilities asserted by the issuer. May be empty. */
  scopes: string[]
  /** Full claim payload. Carries the common verifier token contract plus
   *  boundary-specific custom claims. */
  claims: TClaims
}

export type TokenVerifier<TClaims extends Record<string, unknown> = Record<string, unknown>> = {
  verify(token: string): Promise<TokenClaims<TClaims>>
}

export type ClerkTokenVerifierClaims = JWTPayload & {
  iss: string
  sub: string
  exp: number
  iat?: number
  jti?: string
  sid?: string
  org_id?: string
  orgId?: string
}

export class TokenVerifierError extends Error {
  readonly code: string
  readonly status: number
  constructor(input: { code: string; message: string; status?: number; cause?: unknown }) {
    super(input.message)
    this.name = "TokenVerifierError"
    this.code = input.code
    this.status = input.status ?? 401
    if (input.cause !== undefined) (this as { cause?: unknown }).cause = input.cause
  }
}

// ─────────────────────────────────────────────────────────────────────
// HttpTokenVerifier — calls a remote verifier endpoint over HTTP.
// Use this when your authority lives behind a network call (Clerk,
// Convex, custom OIDC introspection endpoint, etc.).
// ─────────────────────────────────────────────────────────────────────

export type HttpTokenVerifierOptions = {
  /** Verifier endpoint. Must accept POST with `{ token }` JSON body
   *  and return `{ subject: string; scopes?: string[]; claims: TokenVerifierBaseClaims }`
   *  on success, or HTTP non-2xx on failure. */
  endpoint: string
  /** Optional fixed headers (e.g., bearer auth on the verifier itself). */
  headers?: Record<string, string>
  /** fetch override for tests. */
  fetch?: typeof fetch
  /** Request timeout in ms. Default 5000. */
  timeoutMs?: number
}

export function createHttpTokenVerifier(options: HttpTokenVerifierOptions): TokenVerifier<TokenVerifierBaseClaims> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (!fetchImpl) {
    throw new TokenVerifierError({
      code: "fetch_unavailable",
      message: "createHttpTokenVerifier requires a fetch implementation in this runtime",
      status: 500,
    })
  }
  const timeoutMs = options.timeoutMs ?? 5000
  return {
    async verify(token) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetchImpl(options.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.headers ?? {}),
          },
          body: JSON.stringify({ token }),
          signal: controller.signal,
        })
        if (!res.ok) {
          throw new TokenVerifierError({
            code: "verifier_rejected",
            message: `Verifier endpoint returned ${res.status}`,
            status: res.status === 401 || res.status === 403 ? res.status : 401,
          })
        }
        const body = (await res.json().catch(() => null)) as
          | { subject?: string; scopes?: string[]; claims?: Record<string, unknown> }
          | null
        if (!body || typeof body.subject !== "string" || !body.subject) {
          throw new TokenVerifierError({
            code: "verifier_response_invalid",
            message: "Verifier response is missing a subject",
          })
        }
        const claims = tokenVerifierBaseClaims(body.claims)
        if (!claims || claims.sub !== body.subject) {
          throw new TokenVerifierError({
            code: "verifier_response_invalid",
            message: "Verifier response is missing required token claims",
          })
        }
        return {
          subject: body.subject,
          scopes: Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === "string") : [],
          claims,
        }
      } catch (err) {
        if (err instanceof TokenVerifierError) throw err
        throw new TokenVerifierError({
          code: "verifier_unreachable",
          message: err instanceof Error ? err.message : String(err),
          cause: err,
        })
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────
// ClerkTokenVerifier — verifies real Clerk session JWTs against JWKS.
//
// Clerk session tokens are short-lived JWTs. They arrive on backend
// requests through `Authorization: Bearer <token>` or the `__session`
// cookie, and should be verified against the Clerk instance JWKS.
// ─────────────────────────────────────────────────────────────────────

export type ClerkTokenVerifierOptions = {
  issuer: string
  jwksUrl: string
  audience?: string
  scopes?: string[]
  algorithms?: Array<"ES256" | "EdDSA" | "RS256">
}

const clerkJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export function createClerkTokenVerifier(options: ClerkTokenVerifierOptions): TokenVerifier<ClerkTokenVerifierClaims> {
  const algorithms = options.algorithms ?? ["ES256", "EdDSA", "RS256"]
  const remote = clerkJwks.get(options.jwksUrl) ?? createRemoteJWKSet(new URL(options.jwksUrl))
  clerkJwks.set(options.jwksUrl, remote)
  return {
    async verify(token) {
      try {
        const result = await jwtVerify(token, remote, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms,
        })
        const claims = clerkClaims(result.payload)
        if (!claims) {
          throw new TokenVerifierError({
            code: "clerk_claims_invalid",
            message: "Clerk token is missing required session claims",
          })
        }
        return {
          subject: claims.sub,
          scopes: options.scopes ?? scopeClaims(claims),
          claims,
        }
      } catch (err) {
        if (err instanceof TokenVerifierError) throw err
        throw new TokenVerifierError({
          code: "clerk_token_invalid",
          message: "Clerk session token is invalid",
          cause: err,
        })
      }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────
// StaticTokenVerifier — a fixed table of accepted tokens.
//
// Intended for tests, self-hosted single-tenant deployments, and
// integration scenarios where the operator wants to issue tokens out
// of band. NOT for production multi-tenant use.
// ─────────────────────────────────────────────────────────────────────

export type StaticTokenVerifierOptions<TClaims extends Record<string, unknown> = Record<string, unknown>> = {
  /** Map of token string → claims to return. */
  tokens: Record<string, TokenClaims<TClaims>>
}

export function createStaticTokenVerifier<TClaims extends Record<string, unknown> = Record<string, unknown>>(
  options: StaticTokenVerifierOptions<TClaims>,
): TokenVerifier<TClaims> {
  return {
    async verify(token) {
      const claims = options.tokens[token]
      if (!claims) {
        throw new TokenVerifierError({
          code: "token_not_in_static_table",
          message: "Token is not present in the static verifier's accepted set",
        })
      }
      return claims
    },
  }
}

function stringClaim(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

function numberClaim(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function tokenVerifierBaseClaims(input: Record<string, unknown> | undefined): TokenVerifierBaseClaims | undefined {
  if (!input || typeof input !== "object") return
  const iss = stringClaim(input, "iss")
  const aud = stringClaim(input, "aud")
  const sub = stringClaim(input, "sub")
  const workspace_id = stringClaim(input, "workspace_id")
  const host_id = stringClaim(input, "host_id")
  const exp = numberClaim(input, "exp")
  const iat = numberClaim(input, "iat")
  const jti = stringClaim(input, "jti")
  if (!iss || !aud || !sub || !workspace_id || !host_id || !exp || !iat || !jti) return
  return {
    ...input,
    iss,
    aud,
    sub,
    workspace_id,
    host_id,
    exp,
    iat,
    jti,
  }
}

function clerkClaims(input: JWTPayload): ClerkTokenVerifierClaims | undefined {
  if (!input.iss || !input.sub || !input.exp) return
  return {
    ...input,
    iss: input.iss,
    sub: input.sub,
    exp: input.exp,
    ...(input.iat ? { iat: input.iat } : {}),
    ...(typeof input.jti === "string" ? { jti: input.jti } : {}),
    ...(stringClaim(input, "sid") ? { sid: stringClaim(input, "sid") } : {}),
    ...(stringClaim(input, "org_id") ? { org_id: stringClaim(input, "org_id") } : {}),
    ...(stringClaim(input, "orgId") ? { orgId: stringClaim(input, "orgId") } : {}),
  }
}

function scopeClaims(input: Record<string, unknown>) {
  if (Array.isArray(input.scp)) return input.scp.filter((item): item is string => typeof item === "string")
  if (typeof input.scope === "string") return input.scope.split(" ").filter(Boolean)
  return []
}
