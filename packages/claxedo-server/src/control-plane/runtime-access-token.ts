import { exportJWK, importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose"
import { randomToken, sha256Hex16 } from "./web-crypto"

type ExportableKey = Parameters<typeof exportJWK>[0]
// jose's jwtVerify is overloaded — the static-key form accepts any of these.
type VerifyKey = CryptoKey | import("jose").KeyObject | import("jose").JWK | Uint8Array
export type SupervisorBackplaneVerifierKey = VerifyKey
import {
  hostTunnelTokenAudience,
  runtimeAccessTokenAudience,
  runtimeAccessTokenIssuer,
  type RelayJwtAlgorithm,
  type RelayRole,
} from "@claxedo/workspace-relay"
import { ControlPlaneAuthError } from "./auth"

/**
 * Audience claim for the Supervisor Backplane Token (SBT).
 *
 * SBTs authorize **internal management traffic** between the control-plane
 * supervisor and a workspace VM (e.g. pushing a fresh runtime config). They
 * are deliberately distinct from Runtime Access Tokens (audience
 * `workspace-relay`) so a token leaked from one flow cannot be replayed
 * against the other.
 */
export const supervisorBackplaneTokenAudience = "supervisor-backplane"

/**
 * SBTs are issued by the same control-plane authority as the RAT and reuse
 * the same issuer constant. Verifiers MUST still pin the audience to the
 * supervisor-backplane value above to prevent cross-flow replay.
 */
export const supervisorBackplaneTokenIssuer = runtimeAccessTokenIssuer

/** Signer-enforced Runtime Access Token TTL bounds (seconds). */
export const RUNTIME_ACCESS_TOKEN_TTL_BOUNDS_SECONDS = { min: 15 * 60, max: 60 * 60 } as const

/** Signer-enforced Host Tunnel Token TTL bounds (seconds). */
export const HOST_TUNNEL_TOKEN_TTL_BOUNDS_SECONDS = { min: 60, max: 30 * 60 } as const

export type RuntimeAccessTokenSignerInput = {
  subject: string
  orgId: string
  workspaceId: string
  hostId: string
  role: RelayRole
  /** Requested TTL; always clamped to `RUNTIME_ACCESS_TOKEN_TTL_BOUNDS_SECONDS`. */
  ttlSeconds?: number
}

export type RuntimeAccessTokenSignerResult = {
  runtimeAccessToken: string
  tokenExpiresAt: number
  jti: string
}

export type RuntimeAccessTokenSigner = (
  input: RuntimeAccessTokenSignerInput,
) => Promise<RuntimeAccessTokenSignerResult>

export type HostTunnelTokenSignerInput = {
  subject: string
  hostId: string
  workspaceIds: string[]
  /** Requested TTL; always clamped to `HOST_TUNNEL_TOKEN_TTL_BOUNDS_SECONDS`. */
  ttlSeconds?: number
}

export type HostTunnelTokenSignerResult = {
  hostTunnelToken: string
  tokenExpiresAt: number
  jti: string
}

export type HostTunnelTokenSigner = (
  input: HostTunnelTokenSignerInput,
) => Promise<HostTunnelTokenSignerResult>

function clean(input?: string) {
  const value = input?.trim()
  return value ? value : undefined
}

function algorithm(input?: string): RelayJwtAlgorithm {
  if (input === "EdDSA" || input === "ES256" || input === "RS256") return input
  return "EdDSA"
}

function ttlSeconds(env: NodeJS.ProcessEnv) {
  const value = Number(clean(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_TTL_SECONDS))
  const { min, max } = RUNTIME_ACCESS_TOKEN_TTL_BOUNDS_SECONDS
  return Number.isFinite(value) && value >= min && value <= max ? value : 30 * 60
}

function hostTunnelTtlSeconds(env: NodeJS.ProcessEnv) {
  const value = Number(clean(env.CLAXEDO_HOST_TUNNEL_TOKEN_TTL_SECONDS))
  const { min, max } = HOST_TUNNEL_TOKEN_TTL_BOUNDS_SECONDS
  return Number.isFinite(value) && value >= min && value <= max ? value : 5 * 60
}

/** Clamp a requested per-mint TTL to the signer's bounds; fall back when absent/invalid. */
export function clampTtlSeconds(
  requested: number | undefined,
  bounds: { readonly min: number; readonly max: number },
  fallback: number,
) {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return fallback
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(requested)))
}

function pem(input?: string) {
  return clean(input)?.replaceAll("\\n", "\n")
}

async function loadPrivateKey(
  env: NodeJS.ProcessEnv,
  alg: RelayJwtAlgorithm,
  code:
    | "runtime_access_token_signer_unavailable"
    | "host_tunnel_token_signer_unavailable"
    | "supervisor_backplane_token_signer_unavailable",
) {
  const privatePem = pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM)
  if (!privatePem) {
    throw new ControlPlaneAuthError(
      503,
      code,
      "Runtime Access Token signer is not configured",
    )
  }
  return await importPKCS8(privatePem, alg, { extractable: true })
}

async function deriveKidFromPrivateKey(privateKey: ExportableKey): Promise<string> {
  const jwk = await exportJWK(privateKey)
  // For OKP keys (Ed25519) the public component is `x`. For EC, `x` + `y`. For RSA, `n`.
  const material = String(jwk.x ?? jwk.n ?? "")
  if (!material) {
    throw new Error("Unable to derive kid: key has no public component")
  }
  return await sha256Hex16(material)
}

async function deriveKidFromPublicPem(publicPem: string): Promise<string> {
  const publicKey = await importSPKI(publicPem, "EdDSA", { extractable: true })
  const jwk = await exportJWK(publicKey)
  const material = String(jwk.x ?? jwk.n ?? "")
  if (!material) {
    throw new Error("Unable to derive kid: key has no public component")
  }
  return await sha256Hex16(material)
}

/**
 * Resolve the `kid` to embed in the protected header on mint.
 *
 * Precedence:
 *   1. Explicit `CLAXEDO_RUNTIME_ACCESS_TOKEN_KID` env var.
 *   2. SHA-256 of the public-key material (`x` for OKP/EC, `n` for RSA),
 *      sliced to the first 16 hex chars (8 bytes).
 *
 * The SHA-256-of-public-key fallback is stable across processes that share the
 * same key, so the JWKS endpoint and the mint signer agree by construction
 * without explicit configuration.
 */
async function resolveMintKid(env: NodeJS.ProcessEnv, privateKey: ExportableKey): Promise<string> {
  const explicit = clean(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_KID)
  if (explicit) return explicit
  const publicPem = pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM)
  if (publicPem) return await deriveKidFromPublicPem(publicPem)
  return await deriveKidFromPrivateKey(privateKey)
}

export function runtimeAccessTokenSigner(env: NodeJS.ProcessEnv = process.env): RuntimeAccessTokenSigner {
  return async (input) => {
    const alg = algorithm(clean(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM))
    const ttl = clampTtlSeconds(input.ttlSeconds, RUNTIME_ACCESS_TOKEN_TTL_BOUNDS_SECONDS, ttlSeconds(env))
    const now = Date.now()
    const jti = randomToken()
    const privateKey = await loadPrivateKey(env, alg, "runtime_access_token_signer_unavailable")
    const kid = await resolveMintKid(env, privateKey)
    const issuedAt = Math.floor(now / 1000)
    const token = await new SignJWT({
      org_id: input.orgId,
      workspace_id: input.workspaceId,
      host_id: input.hostId,
      role: input.role,
    })
      .setProtectedHeader({ alg, kid })
      .setIssuer(runtimeAccessTokenIssuer)
      .setAudience(runtimeAccessTokenAudience)
      .setSubject(input.subject)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ttl)
      .setJti(jti)
      .sign(privateKey)
    return {
      jti,
      tokenExpiresAt: now + ttl * 1000,
      runtimeAccessToken: token,
    }
  }
}

export function hostTunnelTokenSigner(env: NodeJS.ProcessEnv = process.env): HostTunnelTokenSigner {
  return async (input) => {
    const alg = algorithm(clean(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM))
    const ttl = clampTtlSeconds(input.ttlSeconds, HOST_TUNNEL_TOKEN_TTL_BOUNDS_SECONDS, hostTunnelTtlSeconds(env))
    const now = Date.now()
    const jti = randomToken()
    const privateKey = await loadPrivateKey(env, alg, "host_tunnel_token_signer_unavailable")
    const kid = await resolveMintKid(env, privateKey)
    const issuedAt = Math.floor(now / 1000)
    const token = await new SignJWT({
      host_id: input.hostId,
      workspace_ids: input.workspaceIds,
    })
      .setProtectedHeader({ alg, kid })
      .setIssuer(runtimeAccessTokenIssuer)
      .setAudience(hostTunnelTokenAudience)
      .setSubject(input.subject)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ttl)
      .setJti(jti)
      .sign(privateKey)
    return {
      jti,
      tokenExpiresAt: now + ttl * 1000,
      hostTunnelToken: token,
    }
  }
}

// ---------------------------------------------------------------------------
// Supervisor Backplane Token (SBT)
//
// SBTs are issued by the control-plane supervisor to authorize internal
// management traffic against a workspace VM. Today the canonical use case is
// the periodic config push (`POST /api/wr/config` on the VM). They share the
// RAT signing key for now (so JWKS publication remains unchanged) but always
// carry a distinct audience so callers cannot replay them as RATs.
//
// Token lifetime is intentionally short (60s default) because the supervisor
// is co-located with the signer and re-mints on each push. Verification on
// the central server uses the same private key as the signer; the public-key
// counterpart is published via the existing JWKS endpoint.
// ---------------------------------------------------------------------------

const SUPERVISOR_BACKPLANE_DEFAULT_TTL_SECONDS = 60

export type SupervisorBackplaneTokenClaims = {
  iss: typeof supervisorBackplaneTokenIssuer
  aud: typeof supervisorBackplaneTokenAudience
  sub: string
  workspace_id: string
  host_id: string
  exp: number
  iat: number
  jti: string
  action: "runtime.config.apply"
  scopes: string[]
}

export type SupervisorBackplaneTokenSignerInput = {
  subject: string
  workspaceId: string
  hostId: string
  ttlSeconds?: number
}

export type SupervisorBackplaneTokenSignerResult = {
  supervisorBackplaneToken: string
  tokenExpiresAt: number
  jti: string
}

export type SupervisorBackplaneTokenExpected = {
  workspaceId: string
  hostId?: string
}

function supervisorBackplaneTtlSeconds(input: SupervisorBackplaneTokenSignerInput) {
  const requested = input.ttlSeconds
  if (typeof requested === "number" && Number.isFinite(requested) && requested > 0 && requested <= 5 * 60) {
    return Math.floor(requested)
  }
  return SUPERVISOR_BACKPLANE_DEFAULT_TTL_SECONDS
}

export async function mintSupervisorBackplaneToken(
  input: SupervisorBackplaneTokenSignerInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SupervisorBackplaneTokenSignerResult> {
  const alg = algorithm(clean(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM))
  const ttl = supervisorBackplaneTtlSeconds(input)
  const now = Date.now()
  const jti = randomToken()
  const privateKey = await loadPrivateKey(env, alg, "supervisor_backplane_token_signer_unavailable")
  const kid = await resolveMintKid(env, privateKey)
  const issuedAt = Math.floor(now / 1000)
  const token = await new SignJWT({
    workspace_id: input.workspaceId,
    host_id: input.hostId,
    action: "runtime.config.apply",
    scopes: ["runtime.config.apply"],
  })
    .setProtectedHeader({ alg, kid })
    .setIssuer(supervisorBackplaneTokenIssuer)
    .setAudience(supervisorBackplaneTokenAudience)
    .setSubject(input.subject)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ttl)
    .setJti(jti)
    .sign(privateKey)
  return {
    jti,
    tokenExpiresAt: now + ttl * 1000,
    supervisorBackplaneToken: token,
  }
}

function stringClaim(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberClaim(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export class SupervisorBackplaneAuthError extends Error {
  constructor(
    public readonly code:
      | "invalid_supervisor_backplane_token"
      | "supervisor_backplane_token_workspace_mismatch"
      | "supervisor_backplane_token_host_mismatch"
      | "supervisor_backplane_token_claims_invalid",
    message: string,
  ) {
    super(message)
  }
}

export async function verifySupervisorBackplaneToken(
  token: string,
  key: VerifyKey,
  expected: SupervisorBackplaneTokenExpected,
): Promise<SupervisorBackplaneTokenClaims> {
  let payload: Record<string, unknown>
  try {
    const result = await jwtVerify(token, key, {
      issuer: supervisorBackplaneTokenIssuer,
      audience: supervisorBackplaneTokenAudience,
    })
    payload = result.payload as Record<string, unknown>
  } catch (err) {
    throw new SupervisorBackplaneAuthError(
      "invalid_supervisor_backplane_token",
      err instanceof Error ? err.message : String(err),
    )
  }

  const exp = numberClaim(payload, "exp")
  const iat = numberClaim(payload, "iat")
  const sub = stringClaim(payload, "sub")
  const jti = stringClaim(payload, "jti")
  const workspace_id = stringClaim(payload, "workspace_id")
  const host_id = stringClaim(payload, "host_id")
  const action = stringClaim(payload, "action")
  const scopes = Array.isArray(payload.scopes) ? payload.scopes.filter((item): item is string => typeof item === "string") : []

  if (!exp || !iat || !sub || !jti || !workspace_id || !host_id || action !== "runtime.config.apply") {
    throw new SupervisorBackplaneAuthError(
      "supervisor_backplane_token_claims_invalid",
      "Supervisor Backplane Token claims are incomplete",
    )
  }

  if (workspace_id !== expected.workspaceId) {
    throw new SupervisorBackplaneAuthError(
      "supervisor_backplane_token_workspace_mismatch",
      "Supervisor Backplane Token workspace_id does not match the expected workspace",
    )
  }

  if (expected.hostId !== undefined && host_id !== expected.hostId) {
    throw new SupervisorBackplaneAuthError(
      "supervisor_backplane_token_host_mismatch",
      "Supervisor Backplane Token host_id does not match the expected host",
    )
  }

  return {
    iss: supervisorBackplaneTokenIssuer,
    aud: supervisorBackplaneTokenAudience,
    sub,
    workspace_id,
    host_id,
    exp,
    iat,
    jti,
    action,
    scopes,
  }
}
