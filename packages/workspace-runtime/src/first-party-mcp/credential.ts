import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { base64UrlDecode, base64UrlEncode, timingSafeEqualStrings } from "@claxedo/helpers"
import { rec } from "../json-value"

export type RuntimeCredentialClaims = {
  runtimeId: string
  workspaceId: string
  sessionId?: string
  userId?: string
  issuedAt: number
  expiresAt: number
}

export type RuntimeCredentialVerifier = (token: string) => RuntimeCredentialClaims | undefined

export type RuntimeCredentialIssuer = {
  /** `Authorization` header value for the current token. */
  header(sessionId?: string): string
  current(sessionId?: string): string
  verify: RuntimeCredentialVerifier
  /** Replaces the signing secret; every token minted before this call stops verifying. */
  rotate(): void
}

export type RuntimeCredentialIssuerOptions = {
  runtimeId: string
  workspaceId: string
  userId?: string
  ttlMs?: number
  now?: () => number
}

const ISSUER = "claxedo-workspace-runtime"
const AUDIENCE = "claxedo-mcp"
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const HEADER = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })))

function payloadClaims(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1]
  if (!payload) return undefined
  try {
    return rec(JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))))
  } catch {
    return undefined
  }
}

/**
 * The workspace a token names, read WITHOUT verification. A process hosting
 * several runtimes uses it only to pick which runtime's `verify` to call; the
 * claim is trusted solely once that verify accepts the token.
 */
export function runtimeCredentialWorkspaceId(token: string): string | undefined {
  const workspaceId = payloadClaims(token)?.workspace_id
  return typeof workspaceId === "string" && workspaceId ? workspaceId : undefined
}

/**
 * A harness keeps the token it received at session launch until its next
 * launch, so a token is re-minted once half its lifetime has passed: the copy a
 * long-lived harness holds has at least half the TTL left at any hand-off.
 */
export function createRuntimeCredentialIssuer(options: RuntimeCredentialIssuerOptions): RuntimeCredentialIssuer {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  if (!(ttlMs > 0)) throw new Error("Runtime credential ttlMs must be positive")
  const now = options.now ?? Date.now
  let secret = randomBytes(32)
  let minted: { token: string; issuedAt: number; sessionId?: string } | undefined

  function sign(input: string) {
    return base64UrlEncode(createHmac("sha256", secret).update(input).digest())
  }

  function mint(sessionId?: string) {
    const issuedAt = now()
    const payload = {
      iss: ISSUER,
      aud: AUDIENCE,
      sub: options.runtimeId,
      workspace_id: options.workspaceId,
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(options.userId ? { user_id: options.userId } : {}),
      iat: Math.floor(issuedAt / 1000),
      exp: Math.floor((issuedAt + ttlMs) / 1000),
      jti: randomUUID(),
    }
    const signingInput = `${HEADER}.${base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))}`
    minted = { token: `${signingInput}.${sign(signingInput)}`, issuedAt, sessionId }
    return minted.token
  }

  function current(sessionId?: string) {
    if (!minted || minted.sessionId !== sessionId || now() - minted.issuedAt >= ttlMs / 2) return mint(sessionId)
    return minted.token
  }

  function verify(token: string): RuntimeCredentialClaims | undefined {
    const parts = token.split(".")
    const [header, payload, signature] = parts
    if (parts.length !== 3 || !header || !payload || !signature) return undefined
    if (!/^[A-Za-z0-9_-]+$/.test(signature) || !timingSafeEqualStrings(sign(`${header}.${payload}`), signature)) {
      return undefined
    }
    if (header !== HEADER) return undefined
    const claims = payloadClaims(token)
    if (!claims) return undefined
    if (claims.iss !== ISSUER || claims.aud !== AUDIENCE) return undefined
    if (claims.sub !== options.runtimeId || claims.workspace_id !== options.workspaceId) return undefined
    if (typeof claims.iat !== "number" || typeof claims.exp !== "number") return undefined
    if (claims.exp * 1000 <= now()) return undefined
    if (claims.user_id !== undefined && typeof claims.user_id !== "string") return undefined
    if (claims.session_id !== undefined && (typeof claims.session_id !== "string" || !claims.session_id)) return undefined
    return {
      runtimeId: options.runtimeId,
      workspaceId: options.workspaceId,
      ...(typeof claims.session_id === "string" ? { sessionId: claims.session_id } : {}),
      ...(typeof claims.user_id === "string" ? { userId: claims.user_id } : {}),
      issuedAt: claims.iat * 1000,
      expiresAt: claims.exp * 1000,
    }
  }

  return {
    header: (sessionId) => `Bearer ${current(sessionId)}`,
    current,
    verify,
    rotate() {
      secret = randomBytes(32)
      minted = undefined
    },
  }
}
