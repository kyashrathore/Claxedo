import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { exportJWK, importJWK, importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose"
import { randomToken, sha256Hex16 } from "@claxedo/server-core/platform/auth/web-crypto"

type ExportableKey = Parameters<typeof exportJWK>[0]
// jose's jwtVerify is overloaded — the static-key form accepts any of these.
type VerifyKey = CryptoKey | import("jose").KeyObject | import("jose").JWK | Uint8Array
export type SupervisorBackplaneVerifierKey = VerifyKey
import {
  hostTunnelTokenAudience,
  runtimeAccessTokenAudience,
  runtimeAccessTokenIssuer,
  type RelayRole,
} from "@claxedo/workspace-relay"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"

export const RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA" as const

export type RuntimeAccessTokenConfigurationErrorCode =
  | "runtime_access_token_algorithm_unsupported"
  | "runtime_access_token_public_key_missing"
  | "runtime_access_token_key_pair_mismatch"

// Narrows `code` to this class's union. Merged rather than written as a
// `declare` class field: Playwright's babel transform rejects those unless
// @babel/plugin-transform-typescript is configured, and it loads this file.
export interface RuntimeAccessTokenConfigurationError {
  readonly code: RuntimeAccessTokenConfigurationErrorCode
}

export class RuntimeAccessTokenConfigurationError extends ClaxedoError {
  constructor(code: RuntimeAccessTokenConfigurationErrorCode, message: string) {
    // Misconfiguration, not load: retrying cannot fix an absent or mismatched
    // key, so this fails closed at 503 and stays non-retryable.
    super({ code, message, status: 503 })
  }
}

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
export const documentSessionTokenAudience = "document-session-writeback"
export const documentRelayJobTokenAudience = "document-relay-job"

/** Signer-enforced Runtime Access Token TTL bounds (seconds). */
export const RUNTIME_ACCESS_TOKEN_TTL_BOUNDS_SECONDS = { min: 15 * 60, max: 60 * 60 } as const

/** Signer-enforced Host Tunnel Token TTL bounds (seconds). */
export const HOST_TUNNEL_TOKEN_TTL_BOUNDS_SECONDS = { min: 60, max: 30 * 60 } as const

type RuntimeAccessTokenSignerBaseInput = {
  subject: string
  orgId: string
  workspaceId: string
  hostId: string
  principalKind: "user" | "service"
  actorId: string
  actorKind: "human" | "agent"
  actorPublicId?: string
  actorName?: string
  actorAvatarUrl?: string
  role: RelayRole
  /** Requested TTL; always clamped to `RUNTIME_ACCESS_TOKEN_TTL_BOUNDS_SECONDS`. */
  ttlSeconds?: number
  actorPublicId?: string
  actorName?: string
  actorAvatarUrl?: string
}

export type RuntimeAccessTokenSignerInput = RuntimeAccessTokenSignerBaseInput & {
  actorId: string
  actorKind: "human" | "agent"
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

export function runtimeAccessTokenAlgorithm(env: Record<string, string | undefined>) {
  const configured = clean(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM)
  if (!configured || configured === RUNTIME_ACCESS_TOKEN_ALGORITHM) {
    return RUNTIME_ACCESS_TOKEN_ALGORITHM
  }
  throw new RuntimeAccessTokenConfigurationError(
    "runtime_access_token_algorithm_unsupported",
    `CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM must be ${RUNTIME_ACCESS_TOKEN_ALGORITHM}; got "${configured}"`,
  )
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
  alg: typeof RUNTIME_ACCESS_TOKEN_ALGORITHM,
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

async function keyIdentity(key: ExportableKey) {
  const jwk = await exportJWK(key)
  const material = String(jwk.x ?? "")
  if (!material) {
    throw new Error("Unable to derive kid: key has no public component")
  }
  return { material, kid: await sha256Hex16(material) }
}

/**
 * Resolve the `kid` to embed in the protected header on mint.
 *
 * Precedence:
 *   1. Explicit `CLAXEDO_RUNTIME_ACCESS_TOKEN_KID` env var.
 *   2. SHA-256 of the Ed25519 public-key material (`x`), sliced to the first
 *      16 hex chars (8 bytes).
 *
 * The configured public key must match the private signing key. The stable
 * public-key fallback then keeps JWKS publication and mint headers coherent
 * without explicit `kid` configuration.
 */
async function resolveMintKid(env: NodeJS.ProcessEnv, privateKey: ExportableKey): Promise<string> {
  const publicPem = pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM)
  if (!publicPem) {
    throw new RuntimeAccessTokenConfigurationError(
      "runtime_access_token_public_key_missing",
      "Runtime Access Token signer requires CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM so minted tokens have a published verification key",
    )
  }
  const publicKey = await importSPKI(publicPem, RUNTIME_ACCESS_TOKEN_ALGORITHM, { extractable: true })
  const privateIdentity = await keyIdentity(privateKey)
  const publicIdentity = await keyIdentity(publicKey)
  if (privateIdentity.material !== publicIdentity.material) {
    throw new RuntimeAccessTokenConfigurationError(
      "runtime_access_token_key_pair_mismatch",
      "CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM and CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM are not the same Ed25519 key pair",
    )
  }
  const explicit = clean(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_KID)
  if (explicit) return explicit
  return publicIdentity.kid
}

export function runtimeAccessTokenSigner(env: NodeJS.ProcessEnv = process.env): RuntimeAccessTokenSigner {
  return async (input) => {
    const alg = runtimeAccessTokenAlgorithm(env)
    const ttl = clampTtlSeconds(input.ttlSeconds, RUNTIME_ACCESS_TOKEN_TTL_BOUNDS_SECONDS, ttlSeconds(env))
    const now = Date.now()
    const jti = randomToken()
    const privateKey = await loadPrivateKey(env, alg, "runtime_access_token_signer_unavailable")
    const kid = await resolveMintKid(env, privateKey)
    const issuedAt = Math.floor(now / 1000)
    const token = await new SignJWT({
      actor_id: input.actorId,
      actor_kind: input.actorKind,
      ...(input.actorPublicId && input.actorName
        ? {
            actor_public_id: input.actorPublicId,
            actor_name: input.actorName,
            ...(input.actorAvatarUrl ? { actor_avatar_url: input.actorAvatarUrl } : {}),
          }
        : {}),
      org_id: input.orgId,
      workspace_id: input.workspaceId,
      host_id: input.hostId,
      role: input.role,
    })
      .setProtectedHeader({ alg, kid })
      .setIssuer(runtimeAccessTokenIssuer)
      .setAudience(runtimeAccessTokenAudience)
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
    const alg = runtimeAccessTokenAlgorithm(env)
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
  const alg = runtimeAccessTokenAlgorithm(env)
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
      algorithms: [RUNTIME_ACCESS_TOKEN_ALGORITHM],
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

export type DocumentSessionTokenClaims = Readonly<{
  orgId: string
  projectId: string
  workspaceId: string
  sessionId: string
  documentId: string
  operation: "document.write"
  expiresAt: number
  jobExpiresAt: number
  jti: string
}>

export async function mintDocumentSessionToken(
  input: Omit<DocumentSessionTokenClaims, "operation" | "expiresAt" | "jti"> & { ttlSeconds?: number },
  env: NodeJS.ProcessEnv = process.env,
) {
  const alg = runtimeAccessTokenAlgorithm(env)
  const privateKey = await loadPrivateKey(env, alg, "runtime_access_token_signer_unavailable")
  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAt = Math.min(input.jobExpiresAt, issuedAt + Math.min(300, Math.max(15, Math.floor(input.ttlSeconds ?? 300))))
  if (expiresAt <= issuedAt) throw new Error("Document session job has expired")
  const jti = randomToken()
  const token = await new SignJWT({
    org_id: input.orgId,
    project_id: input.projectId,
    workspace_id: input.workspaceId,
    session_id: input.sessionId,
    document_id: input.documentId,
    operation: "document.write",
    job_exp: input.jobExpiresAt,
  })
    .setProtectedHeader({ alg, kid: await resolveMintKid(env, privateKey) })
    .setIssuer(runtimeAccessTokenIssuer)
    .setAudience(documentSessionTokenAudience)
    .setSubject(`session:${input.sessionId}`)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .setJti(jti)
    .sign(privateKey)
  return { token, expiresAt: expiresAt * 1000, jti }
}

export async function verifyDocumentSessionToken(
  token: string,
  expected: Omit<DocumentSessionTokenClaims, "operation" | "expiresAt" | "jobExpiresAt" | "jti">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DocumentSessionTokenClaims> {
  const alg = runtimeAccessTokenAlgorithm(env)
  const privateKey = await loadPrivateKey(env, alg, "runtime_access_token_signer_unavailable")
  const jwk = await exportJWK(privateKey)
  const publicJwk = { ...jwk }
  const fields = publicJwk as Record<string, unknown>
  for (const field of ["d", "p", "q", "dp", "dq", "qi", "oth"]) delete fields[field]
  const key = await importJWK(publicJwk, alg)
  const result = await jwtVerify(token, key, {
    algorithms: [RUNTIME_ACCESS_TOKEN_ALGORITHM],
    issuer: runtimeAccessTokenIssuer,
    audience: documentSessionTokenAudience,
  })
  const payload = result.payload as Record<string, unknown>
  const claims = {
    orgId: stringClaim(payload, "org_id"),
    projectId: stringClaim(payload, "project_id"),
    workspaceId: stringClaim(payload, "workspace_id"),
    sessionId: stringClaim(payload, "session_id"),
    documentId: stringClaim(payload, "document_id"),
    operation: stringClaim(payload, "operation"),
    expiresAt: numberClaim(payload, "exp"),
    jobExpiresAt: numberClaim(payload, "job_exp"),
    jti: stringClaim(payload, "jti"),
  }
  if (claims.operation !== "document.write" || !claims.expiresAt || !claims.jobExpiresAt || !claims.jti ||
    claims.jobExpiresAt <= Math.floor(Date.now() / 1000) ||
    claims.orgId !== expected.orgId || claims.projectId !== expected.projectId ||
    claims.workspaceId !== expected.workspaceId || claims.sessionId !== expected.sessionId ||
    claims.documentId !== expected.documentId) {
    throw new Error("Document Session Token scope is invalid")
  }
  return {
    ...expected, operation: "document.write", expiresAt: claims.expiresAt,
    jobExpiresAt: claims.jobExpiresAt, jti: claims.jti,
  }
}

export type DocumentRelayJobScope = Readonly<{
  userId: string
  orgId: string
  projectId: string
  localWorkspaceId: string
  cloudWorkspaceId: string
  sessionId: string
  documentId: string
  operations: readonly ("hydrate" | "read" | "write" | "resolve")[]
  jobExpiresAt: number
}>

export async function mintDocumentRelayJobToken(
  input: DocumentRelayJobScope,
  env: NodeJS.ProcessEnv = process.env,
) {
  const alg = runtimeAccessTokenAlgorithm(env)
  const privateKey = await loadPrivateKey(env, alg, "runtime_access_token_signer_unavailable")
  const now = Math.floor(Date.now() / 1000)
  const exp = Math.min(input.jobExpiresAt, now + 5 * 60)
  if (exp <= now) throw new Error("Document relay job has expired")
  const jti = randomToken()
  const token = await new SignJWT({
    user_id: input.userId,
    org_id: input.orgId,
    project_id: input.projectId,
    local_workspace_id: input.localWorkspaceId,
    cloud_workspace_id: input.cloudWorkspaceId,
    session_id: input.sessionId,
    document_id: input.documentId,
    operations: input.operations,
    job_exp: input.jobExpiresAt,
  })
    .setProtectedHeader({ alg, kid: await resolveMintKid(env, privateKey) })
    .setIssuer(runtimeAccessTokenIssuer)
    .setAudience(documentRelayJobTokenAudience)
    .setSubject(input.userId)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(privateKey)
  return { token, expiresAt: exp * 1000, jti }
}

export async function verifyDocumentRelayJobToken(
  token: string,
  expected: Omit<DocumentRelayJobScope, "operations" | "jobExpiresAt"> & { operation: DocumentRelayJobScope["operations"][number] },
  env: NodeJS.ProcessEnv = process.env,
) {
  const alg = runtimeAccessTokenAlgorithm(env)
  const key = await documentVerificationKey(env, alg)
  const result = await jwtVerify(token, key, {
    algorithms: [RUNTIME_ACCESS_TOKEN_ALGORITHM],
    issuer: runtimeAccessTokenIssuer,
    audience: documentRelayJobTokenAudience,
  })
  const payload = result.payload as Record<string, unknown>
  const operations = Array.isArray(payload.operations) ? payload.operations.filter((value): value is string => typeof value === "string") : []
  const jobExpiresAt = numberClaim(payload, "job_exp")
  const jti = stringClaim(payload, "jti")
  if (!jti || !jobExpiresAt || jobExpiresAt <= Math.floor(Date.now() / 1000) || !operations.includes(expected.operation) ||
    stringClaim(payload, "user_id") !== expected.userId || stringClaim(payload, "org_id") !== expected.orgId ||
    stringClaim(payload, "project_id") !== expected.projectId || stringClaim(payload, "local_workspace_id") !== expected.localWorkspaceId ||
    stringClaim(payload, "cloud_workspace_id") !== expected.cloudWorkspaceId || stringClaim(payload, "session_id") !== expected.sessionId ||
    stringClaim(payload, "document_id") !== expected.documentId) throw new Error("Document relay job scope is invalid")
  return { ...expected, operations, jobExpiresAt, jti }
}

async function documentVerificationKey(env: NodeJS.ProcessEnv, alg: typeof RUNTIME_ACCESS_TOKEN_ALGORITHM) {
  const publicPem = pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM)
  if (publicPem) return await importSPKI(publicPem, alg)
  const privateKey = await loadPrivateKey(env, alg, "runtime_access_token_signer_unavailable")
  const publicJwk = { ...await exportJWK(privateKey) }
  const fields = publicJwk as Record<string, unknown>
  for (const field of ["d", "p", "q", "dp", "dq", "qi", "oth"]) delete fields[field]
  return await importJWK(publicJwk, alg)
}
