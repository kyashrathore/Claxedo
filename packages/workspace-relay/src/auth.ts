import { SignJWT, errors, exportJWK, importJWK, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose"
import { numberClaim } from "@claxedo/helpers/guards"

const algorithms = ["EdDSA", "ES256", "RS256"] as const

export const runtimeAccessTokenIssuer = "claxedo-control-plane"
export const runtimeAccessTokenAudience = "workspace-relay"
export const hostTunnelTokenAudience = "workspace-relay-host-tunnel"
export const relayHostTokenIssuer = "workspace-relay"
export const relayHostTokenAudience = "workspace-host-service"

/**
 * Where the workspace behind a relayed request runs: the provisioner's machine
 * (`cloud-vm`) or an enrolled one (`local-worktree`). The only placement word
 * on the relay wire; the control plane stores the same two.
 */
export type RelayBacking = "cloud-vm" | "local-worktree"
export type RelayJwtAlgorithm = (typeof algorithms)[number]
export type RelayRole = "viewer" | "editor" | "admin" | "owner"
export type ActorKind = "human" | "agent"

export type RuntimeAccessTokenClaims = {
  iss: typeof runtimeAccessTokenIssuer
  aud: typeof runtimeAccessTokenAudience
  principal_kind: "user" | "service"
  actor_id: string
  actor_kind: "human" | "agent"
  actor_public_id?: string
  actor_name?: string
  actor_avatar_url?: string
  org_id: string
  workspace_id: string
  host_id: string
  role: RelayRole
  exp: number
  iat: number
  jti: string
}

export type RelayHostTokenClaims = {
  iss: typeof relayHostTokenIssuer
  aud: typeof relayHostTokenAudience
  principal_kind: "user" | "service"
  actor_id: string
  actor_kind: "human" | "agent"
  actor_public_id?: string
  actor_name?: string
  actor_avatar_url?: string
  org_id: string
  workspace_id: string
  host_id: string
  role: RelayRole
  exp: number
  iat: number
  jti: string
  /** Durable parent Runtime Access Token id used for revocation checks. */
  parent_jti: string
  backing: RelayBacking
}

export type HostTunnelTokenClaims = {
  iss: typeof runtimeAccessTokenIssuer
  aud: typeof hostTunnelTokenAudience
  sub: string
  host_id: string
  workspace_ids: string[]
  /**
   * Serving-generation fence. `generation` is only valid together with
   * `enrollment_id`; a relay with a host-generation resolver refuses a token
   * whose generation is below the enrollment's current one. A token without a
   * generation is admitted exactly as before the fence existed, which is what
   * desktop and self-hosted mints still produce.
   */
  enrollment_id?: string
  generation?: number
  exp: number
  iat: number
  jti: string
}

export class WorkspaceRelayAuthError extends Error {
  constructor(
    public readonly code:
      | "invalid_relay_token"
      | "relay_token_workspace_mismatch"
      | "relay_token_host_mismatch"
      | "relay_token_claims_invalid",
    message: string,
  ) {
    super(message)
  }
}

type RuntimeInput = {
  principalKind: "user" | "service"
  actorId: string
  actorKind: ActorKind
  actorPublicId?: string
  actorName?: string
  actorAvatarUrl?: string
  orgId: string
  workspaceId: string
  hostId: string
  role: RelayRole
  ttlSeconds?: number
  jti?: string
  now?: number
}

type RelayHostInput = RuntimeInput & {
  backing: RelayBacking
  /** The Runtime Access Token jti from which this one-request RHT is derived. */
  parentJti: string
  /**
   * Optional `kid` to embed in the JWT protected header. Verifiers using a
   * JWKS resolver dispatch on this to pick the matching key, so a freshly
   * minted RHT must carry the same `kid` that the relay publishes at
   * `/.well-known/jwks.json`. When omitted, the header has no `kid` and
   * verifiers fall back to single-key matching (PEM env-var path).
   */
  kid?: string
}

type HostTunnelInput = {
  subject: string
  hostId: string
  workspaceIds: string[]
  enrollmentId?: string
  generation?: number
  ttlSeconds?: number
  jti?: string
  now?: number
}

type ExpectedTarget = {
  workspaceId: string
  hostId?: string
}

type ExpectedHostTunnel = {
  hostId: string
  workspaceIds: string[]
}

function jti() {
  return crypto.randomUUID()
}

function seconds(input = Date.now()) {
  return Math.floor(input / 1000)
}

function requireAlgorithm(input: string): RelayJwtAlgorithm {
  const algorithm = algorithms.find((candidate) => candidate === input)
  if (algorithm) return algorithm
  throw new WorkspaceRelayAuthError("invalid_relay_token", "Unsupported relay token algorithm")
}

function stringClaim(payload: JWTPayload, key: string) {
  const value = payload[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

function stringArrayClaim(payload: JWTPayload, key: string) {
  const value = payload[key]
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim()) ? value : undefined
}

export function isHostGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

/**
 * The fence pair as it appears in a token payload: `undefined` when absent,
 * `null` when present but unusable (a generation that is not a non-negative
 * integer, or a generation without its enrollment id).
 */
function hostGenerationClaims(payload: JWTPayload) {
  const enrollment_id = stringClaim(payload, "enrollment_id")
  const generation = payload.generation
  if (generation === undefined) return enrollment_id ? { enrollment_id } : {}
  if (!isHostGeneration(generation) || !enrollment_id) return null
  return { enrollment_id, generation }
}

function roleClaim(payload: JWTPayload) {
  const value = stringClaim(payload, "role")
  return value === "viewer" || value === "editor" || value === "admin" || value === "owner" ? value : undefined
}

function actorProfileClaims(payload: JWTPayload) {
  const actor_public_id = stringClaim(payload, "actor_public_id")
  const actor_name = stringClaim(payload, "actor_name")
  const actor_avatar_url = stringClaim(payload, "actor_avatar_url")
  if (!actor_public_id && !actor_name && !actor_avatar_url) return {}
  if (!actor_public_id || !actor_name) return undefined
  return { actor_public_id, actor_name, ...(actor_avatar_url ? { actor_avatar_url } : {}) }
}

function actorProfilePayload(input: {
  actorPublicId?: string
  actorName?: string
  actorAvatarUrl?: string
}) {
  if (!input.actorPublicId && !input.actorName && !input.actorAvatarUrl) return {}
  if (!input.actorPublicId || !input.actorName) {
    throw new WorkspaceRelayAuthError("relay_token_claims_invalid", "Actor display profile claims are incomplete")
  }
  return {
    actor_public_id: input.actorPublicId,
    actor_name: input.actorName,
    ...(input.actorAvatarUrl ? { actor_avatar_url: input.actorAvatarUrl } : {}),
  }
}

export function isRelayBacking(input: unknown): input is RelayBacking {
  return input === "cloud-vm" || input === "local-worktree"
}

function checkHostTunnelTarget(payload: JWTPayload, expected: ExpectedHostTunnel) {
  if (stringClaim(payload, "host_id") !== expected.hostId) {
    throw new WorkspaceRelayAuthError("relay_token_host_mismatch", "Relay token host does not match request")
  }
  const workspaceIds = stringArrayClaim(payload, "workspace_ids") ?? []
  if (expected.workspaceIds.some((workspaceId) => !workspaceIds.includes(workspaceId))) {
    throw new WorkspaceRelayAuthError("relay_token_workspace_mismatch", "Relay token workspace does not match request")
  }
}

function checkTarget(payload: JWTPayload, expected: ExpectedTarget) {
  if (stringClaim(payload, "workspace_id") !== expected.workspaceId) {
    throw new WorkspaceRelayAuthError("relay_token_workspace_mismatch", "Relay token workspace does not match request")
  }
  if (expected.hostId && stringClaim(payload, "host_id") !== expected.hostId) {
    throw new WorkspaceRelayAuthError("relay_token_host_mismatch", "Relay token host does not match request")
  }
}

/**
 * Resolver function returned by `createRemoteJWKSet` / `createLocalJWKSet`.
 * Accepted by `jwtVerify` directly — jose dispatches based on whether the
 * argument is callable.
 */
export type RelayKeyResolver = JWTVerifyGetKey

export type RelayKey = CryptoKey | Uint8Array | RelayKeyResolver

/**
 * Re-imports the PUBLIC half of an EdDSA relay-host signing key.
 *
 * `importJWK` is declared `Promise<CryptoKey | Uint8Array>` because a symmetric
 * (`oct`) JWK imports as raw bytes. An EdDSA public JWK never does, so the byte
 * branch is a configuration error worth failing loudly on — the two callers
 * (`main.ts` for Bun, `worker.ts` for Cloudflare) previously asserted it away
 * with their own copies of this round-trip.
 */
export async function deriveRelayHostPublicKey(privateKey: CryptoKey): Promise<CryptoKey> {
  const jwk = await exportJWK(privateKey)
  const imported = await importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }, "EdDSA", { extractable: true })
  if (imported instanceof Uint8Array) {
    throw new Error("Relay host public key imported as raw bytes; expected an EdDSA public key")
  }
  return imported
}

/**
 * The relay-host key id, derived from the key's public component.
 *
 * ONE implementation on purpose: a Bun relay and a Cloudflare relay signing
 * with the same key must publish the same `kid`, or a token minted by one fails
 * key lookup at the other. It is written against WebCrypto rather than
 * `node:crypto` so the workerd bundle can use it too.
 */
export async function deriveRelayHostKid(publicKey: CryptoKey): Promise<string> {
  const jwk = await exportJWK(publicKey)
  const material = jwk.x ?? jwk.n ?? ""
  if (!material) throw new Error("Cannot derive kid: public key has no public component")
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16)
}

async function verifyJwt(token: string, key: RelayKey, input: {
  issuer: string
  audience: string
}) {
  try {
    if (typeof key === "function") {
      return await jwtVerify(token, key, {
        issuer: input.issuer,
        audience: input.audience,
        algorithms: [...algorithms],
      })
    }
    return await jwtVerify(token, key, {
      issuer: input.issuer,
      audience: input.audience,
      algorithms: [...algorithms],
    })
  } catch (err) {
    if (err instanceof errors.JWKSTimeout) throw err
    if (err instanceof errors.JOSEError) {
      throw new WorkspaceRelayAuthError("invalid_relay_token", "Relay token is invalid")
    }
    throw err
  }
}

/**
 * Mint variants accept only a signing key — never a resolver. Resolvers are
 * verification-only. This narrowed alias keeps the mint signatures unchanged.
 */
type RelaySigningKey = CryptoKey | Uint8Array

export async function mintRuntimeAccessToken(input: RuntimeInput, key: RelaySigningKey, alg: RelayJwtAlgorithm) {
  const now = seconds(input.now)
  return await new SignJWT({
    principal_kind: input.principalKind,
    actor_id: input.actorId,
    actor_kind: input.actorKind,
    ...actorProfilePayload(input),
    org_id: input.orgId,
    workspace_id: input.workspaceId,
    host_id: input.hostId,
    role: input.role,
  })
    .setProtectedHeader({ alg: requireAlgorithm(alg) })
    .setIssuer(runtimeAccessTokenIssuer)
    .setAudience(runtimeAccessTokenAudience)
    .setIssuedAt(now)
    .setExpirationTime(now + (input.ttlSeconds ?? 30 * 60))
    .setJti(input.jti ?? jti())
    .sign(key)
}

export async function verifyRuntimeAccessToken(token: string, key: RelayKey, expected: ExpectedTarget) {
  const result = await verifyJwt(token, key, {
    issuer: runtimeAccessTokenIssuer,
    audience: runtimeAccessTokenAudience,
  })
  checkTarget(result.payload, expected)
  const claims = runtimeClaims(result.payload)
  if (!claims) {
    throw new WorkspaceRelayAuthError("relay_token_claims_invalid", "Runtime Access Token claims are incomplete")
  }
  return claims
}

/**
 * Clock bounds applied to claims a custom `tokenVerifier` returns. The
 * built-in JWT path gets the same floor from jose inside `verifyJwt`; a
 * verifier result crosses this boundary instead, so the floor is re-stated
 * here where no verifier implementation can skip it: expired past a small
 * skew, `nbf` beyond that skew, or an exp so far out the token is
 * effectively immortal are all refused.
 */
const RUNTIME_ACCESS_TOKEN_CLOCK_SKEW_SECONDS = 60
const RUNTIME_ACCESS_TOKEN_MAX_LIFETIME_SECONDS = 24 * 60 * 60

function checkRuntimeAccessTokenTimeClaims(payload: JWTPayload, claims: RuntimeAccessTokenClaims) {
  const now = seconds()
  if (claims.exp <= now - RUNTIME_ACCESS_TOKEN_CLOCK_SKEW_SECONDS) {
    throw new WorkspaceRelayAuthError("relay_token_claims_invalid", "Runtime Access Token is expired")
  }
  const nbf = numberClaim(payload, "nbf")
  if (payload.nbf !== undefined && nbf === undefined) {
    throw new WorkspaceRelayAuthError("relay_token_claims_invalid", "Runtime Access Token nbf claim is not a finite number")
  }
  if (nbf !== undefined && nbf > now + RUNTIME_ACCESS_TOKEN_CLOCK_SKEW_SECONDS) {
    throw new WorkspaceRelayAuthError("relay_token_claims_invalid", "Runtime Access Token is not yet valid")
  }
  if (claims.exp > now + RUNTIME_ACCESS_TOKEN_MAX_LIFETIME_SECONDS) {
    throw new WorkspaceRelayAuthError("relay_token_claims_invalid", "Runtime Access Token lifetime exceeds the relay maximum")
  }
}

export function validateRuntimeAccessTokenClaims(input: Record<string, unknown>, expected: ExpectedTarget) {
  const payload = input as JWTPayload
  if (stringClaim(payload, "iss") !== runtimeAccessTokenIssuer || stringClaim(payload, "aud") !== runtimeAccessTokenAudience) {
    throw new WorkspaceRelayAuthError("relay_token_claims_invalid", "Runtime Access Token issuer or audience is invalid")
  }
  checkTarget(payload, expected)
  const claims = runtimeClaims(payload)
  if (!claims) {
    throw new WorkspaceRelayAuthError("relay_token_claims_invalid", "Runtime Access Token claims are incomplete")
  }
  checkRuntimeAccessTokenTimeClaims(payload, claims)
  return claims
}

export async function mintHostTunnelToken(input: HostTunnelInput, key: RelaySigningKey, alg: RelayJwtAlgorithm) {
  const now = seconds(input.now)
  if (input.generation !== undefined && (!isHostGeneration(input.generation) || !input.enrollmentId)) {
    throw new WorkspaceRelayAuthError("relay_token_claims_invalid", "Host Tunnel Token generation requires a non-negative integer and an enrollment id")
  }
  return await new SignJWT({
    host_id: input.hostId,
    workspace_ids: input.workspaceIds,
    ...(input.enrollmentId ? { enrollment_id: input.enrollmentId } : {}),
    ...(input.generation !== undefined ? { generation: input.generation } : {}),
  })
    .setProtectedHeader({ alg: requireAlgorithm(alg) })
    .setIssuer(runtimeAccessTokenIssuer)
    .setAudience(hostTunnelTokenAudience)
    .setSubject(input.subject)
    .setIssuedAt(now)
    .setExpirationTime(now + (input.ttlSeconds ?? 5 * 60))
    .setJti(input.jti ?? jti())
    .sign(key)
}

export async function verifyHostTunnelToken(token: string, key: RelayKey, expected: ExpectedHostTunnel) {
  const result = await verifyJwt(token, key, {
    issuer: runtimeAccessTokenIssuer,
    audience: hostTunnelTokenAudience,
  })
  checkHostTunnelTarget(result.payload, expected)
  const claims = hostTunnelClaims(result.payload)
  if (!claims) {
    throw new WorkspaceRelayAuthError("relay_token_claims_invalid", "Host Tunnel Token claims are incomplete")
  }
  return claims
}

// RHT lifetime semantics:
// The Relay Host Token (RHT) authenticates a SINGLE inbound HTTP request or
// WebSocket upgrade from Workspace Relay to Workspace Host Service. TTL is
// fixed at 60 seconds — short enough to bound replay-attack windows, long
// enough to tolerate clock skew. The relay re-mints a fresh RHT for every
// new request.
//
// Long-lived sockets (PTY, SSE, agent event streams) survive past the RHT's
// expiry by design. The RHT validates the CONNECTION ESTABLISHMENT; the
// socket's lifetime is bounded by the host service's own session, not the
// RHT TTL. Reconnects re-mint a fresh RHT.
//
// This mirrors the OAuth-protected SSE/WebSocket pattern used elsewhere in
// the industry. Do not refresh RHTs mid-stream — that would put the relay
// (and Control Plane via the resolver) in the streaming critical path with
// no security benefit.
export async function mintRelayHostToken(input: RelayHostInput, key: RelaySigningKey, alg: RelayJwtAlgorithm) {
  if (!isRelayBacking(input.backing)) {
    throw new WorkspaceRelayAuthError("relay_token_claims_invalid", "Relay Host Token backing claim is not a placement")
  }
  const now = seconds(input.now)
  const protectedHeader: { alg: RelayJwtAlgorithm; kid?: string } = { alg: requireAlgorithm(alg) }
  if (input.kid) protectedHeader.kid = input.kid
  return await new SignJWT({
    principal_kind: input.principalKind,
    actor_id: input.actorId,
    actor_kind: input.actorKind,
    ...actorProfilePayload(input),
    org_id: input.orgId,
    workspace_id: input.workspaceId,
    host_id: input.hostId,
    role: input.role,
    backing: input.backing,
    parent_jti: input.parentJti,
  })
    .setProtectedHeader(protectedHeader)
    .setIssuer(relayHostTokenIssuer)
    .setAudience(relayHostTokenAudience)
    .setIssuedAt(now)
    .setExpirationTime(now + (input.ttlSeconds ?? 60))
    .setJti(input.jti ?? jti())
    .sign(key)
}

export async function verifyRelayHostToken(token: string, key: RelayKey, expected: ExpectedTarget) {
  const result = await verifyJwt(token, key, {
    issuer: relayHostTokenIssuer,
    audience: relayHostTokenAudience,
  })
  checkTarget(result.payload, expected)
  const claims = relayHostClaims(result.payload)
  if (!claims) {
    throw new WorkspaceRelayAuthError("relay_token_claims_invalid", "Relay Host Token claims are incomplete")
  }
  return claims
}

function runtimeClaims(payload: JWTPayload): RuntimeAccessTokenClaims | undefined {
  const exp = numberClaim(payload, "exp")
  const iat = numberClaim(payload, "iat")
  const principal_kind = stringClaim(payload, "principal_kind")
  const actor_id = stringClaim(payload, "actor_id")
  const actor_kind = stringClaim(payload, "actor_kind")
  const jti = stringClaim(payload, "jti")
  const org_id = stringClaim(payload, "org_id")
  const workspace_id = stringClaim(payload, "workspace_id")
  const host_id = stringClaim(payload, "host_id")
  const role = roleClaim(payload)
  if (
    !exp || !iat || !jti || !org_id || !workspace_id || !host_id || !role || !actor_id
    || (principal_kind !== "user" && principal_kind !== "service")
    || (actor_kind !== "human" && actor_kind !== "agent")
    || (principal_kind === "user" && actor_kind !== "human")
    || (principal_kind === "service" && actor_kind !== "agent")
  ) return undefined
  const actorProfile = actorProfileClaims(payload)
  if (!actorProfile) return undefined
  return {
    iss: runtimeAccessTokenIssuer,
    aud: runtimeAccessTokenAudience,
    principal_kind,
    actor_id,
    actor_kind,
    ...actorProfile,
    org_id,
    workspace_id,
    host_id,
    role,
    exp,
    iat,
    jti,
  }
}

function relayHostClaims(payload: JWTPayload): RelayHostTokenClaims | undefined {
  const base = runtimeClaims({
    ...payload,
    iss: runtimeAccessTokenIssuer,
    aud: runtimeAccessTokenAudience,
  })
  // An `access` claim is the retired spelling of this same fact. A token
  // carrying it was minted by a control plane on the other side of the
  // placement change, whose `backing` may disagree with it; refuse rather than
  // pick one.
  if (payload.access !== undefined) return undefined
  const backing = stringClaim(payload, "backing")
  const parent_jti = stringClaim(payload, "parent_jti")
  if (!base || !parent_jti || !isRelayBacking(backing)) return undefined
  return {
    ...base,
    iss: relayHostTokenIssuer,
    aud: relayHostTokenAudience,
    parent_jti,
    backing,
  }
}

function hostTunnelClaims(payload: JWTPayload): HostTunnelTokenClaims | undefined {
  const exp = numberClaim(payload, "exp")
  const iat = numberClaim(payload, "iat")
  const sub = stringClaim(payload, "sub")
  const jti = stringClaim(payload, "jti")
  const host_id = stringClaim(payload, "host_id")
  const workspace_ids = stringArrayClaim(payload, "workspace_ids")
  const fence = hostGenerationClaims(payload)
  if (!exp || !iat || !sub || !jti || !host_id || !workspace_ids?.length || fence === null) return undefined
  return {
    iss: runtimeAccessTokenIssuer,
    aud: hostTunnelTokenAudience,
    sub,
    host_id,
    workspace_ids,
    ...fence,
    exp,
    iat,
    jti,
  }
}
