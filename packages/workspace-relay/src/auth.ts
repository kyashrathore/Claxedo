import { SignJWT, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose"

const algorithms = ["EdDSA", "ES256", "RS256"] as const

export const runtimeAccessTokenIssuer = "claxedo-control-plane"
export const runtimeAccessTokenAudience = "workspace-relay"
export const hostTunnelTokenAudience = "workspace-relay-host-tunnel"
export const relayHostTokenIssuer = "workspace-relay"
export const relayHostTokenAudience = "workspace-host-service"

export type RelayClaimPair =
  | { access: "cloud"; backing: "cloud-vm" }
  | { access: "user-hosted"; backing: "local-worktree" }
export type RelayAccess = RelayClaimPair["access"]
export type RelayBacking = RelayClaimPair["backing"]
export type RelayJwtAlgorithm = (typeof algorithms)[number]
export type RelayRole = "viewer" | "editor" | "admin" | "owner"
export type ActorKind = "human" | "agent"

type OptionalActorClaims =
  | { actor_id: string; actor_kind: ActorKind }
  | { actor_id?: undefined; actor_kind?: undefined }

type OptionalActorInput =
  | { actorId: string; actorKind: ActorKind }
  | { actorId?: undefined; actorKind?: undefined }

type OptionalActorProfileClaims = {
  actor_public_id?: string
  actor_name?: string
  actor_avatar_url?: string
}

type OptionalActorProfileInput = {
  actorPublicId?: string
  actorName?: string
  actorAvatarUrl?: string
}

export type RuntimeAccessTokenClaims = {
  iss: typeof runtimeAccessTokenIssuer
  aud: typeof runtimeAccessTokenAudience
  sub: string
  org_id: string
  workspace_id: string
  host_id: string
  role: RelayRole
  exp: number
  iat: number
  jti: string
} & OptionalActorClaims & OptionalActorProfileClaims

export type RelayHostTokenClaims = {
  iss: typeof relayHostTokenIssuer
  aud: typeof relayHostTokenAudience
  sub: string
  org_id: string
  workspace_id: string
  host_id: string
  role: RelayRole
  exp: number
  iat: number
  jti: string
} & RelayClaimPair & OptionalActorClaims & OptionalActorProfileClaims

export type HostTunnelTokenClaims = {
  iss: typeof runtimeAccessTokenIssuer
  aud: typeof hostTunnelTokenAudience
  sub: string
  host_id: string
  workspace_ids: string[]
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

type RuntimeInput = OptionalActorInput & OptionalActorProfileInput & {
  subject: string
  orgId: string
  workspaceId: string
  hostId: string
  role: RelayRole
  ttlSeconds?: number
  jti?: string
  now?: number
}

type RelayHostInput = RuntimeInput & RelayClaimPair & {
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
  if (algorithms.includes(input as RelayJwtAlgorithm)) return input as RelayJwtAlgorithm
  throw new WorkspaceRelayAuthError("invalid_relay_token", "Unsupported relay token algorithm")
}

function stringClaim(payload: JWTPayload, key: string) {
  const value = payload[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

function numberClaim(payload: JWTPayload, key: string) {
  const value = payload[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringArrayClaim(payload: JWTPayload, key: string) {
  const value = payload[key]
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim()) ? value : undefined
}

function roleClaim(payload: JWTPayload) {
  const value = stringClaim(payload, "role")
  return value === "viewer" || value === "editor" || value === "admin" || value === "owner" ? value : undefined
}

function actorKindClaim(payload: JWTPayload) {
  const value = stringClaim(payload, "actor_kind")
  return value === "human" || value === "agent" ? value : undefined
}

function actorClaims(payload: JWTPayload): OptionalActorClaims | undefined {
  const actor_id = stringClaim(payload, "actor_id")
  const actor_kind = actorKindClaim(payload)
  if (!actor_id && !actor_kind) return { actor_id: undefined, actor_kind: undefined }
  if (!actor_id || !actor_kind) return
  return { actor_id, actor_kind }
}

function actorPayload(input: OptionalActorInput) {
  if (!input.actorId && !input.actorKind) return {}
  if (!input.actorId || !input.actorKind) {
    throw new WorkspaceRelayAuthError("relay_token_claims_invalid", "Actor identity claims are incomplete")
  }
  return { actor_id: input.actorId, actor_kind: input.actorKind }
}

function actorProfileClaims(payload: JWTPayload): OptionalActorProfileClaims | undefined {
  const actor_public_id = stringClaim(payload, "actor_public_id")
  const actor_name = stringClaim(payload, "actor_name")
  const actor_avatar_url = stringClaim(payload, "actor_avatar_url")
  if (!actor_public_id && !actor_name && !actor_avatar_url) return {}
  if (!actor_public_id || !actor_name) return
  return { actor_public_id, actor_name, ...(actor_avatar_url ? { actor_avatar_url } : {}) }
}

function actorProfilePayload(input: OptionalActorProfileInput) {
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

export function isRelayClaimPair(input: { access?: unknown; backing?: unknown }): input is RelayClaimPair {
  return (
    input.access === "cloud" && input.backing === "cloud-vm"
  ) || (
    input.access === "user-hosted" && input.backing === "local-worktree"
  )
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
    ...actorPayload(input),
    ...actorProfilePayload(input),
    org_id: input.orgId,
    workspace_id: input.workspaceId,
    host_id: input.hostId,
    role: input.role,
  })
    .setProtectedHeader({ alg: requireAlgorithm(alg) })
    .setIssuer(runtimeAccessTokenIssuer)
    .setAudience(runtimeAccessTokenAudience)
    .setSubject(input.subject)
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
  return claims
}

export async function mintHostTunnelToken(input: HostTunnelInput, key: RelaySigningKey, alg: RelayJwtAlgorithm) {
  const now = seconds(input.now)
  return await new SignJWT({
    host_id: input.hostId,
    workspace_ids: input.workspaceIds,
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
  if (!isRelayClaimPair(input)) {
    throw new WorkspaceRelayAuthError("relay_token_claims_invalid", "Relay Host Token access/backing claims are inconsistent")
  }
  const now = seconds(input.now)
  const protectedHeader: { alg: RelayJwtAlgorithm; kid?: string } = { alg: requireAlgorithm(alg) }
  if (input.kid) protectedHeader.kid = input.kid
  return await new SignJWT({
    ...actorPayload(input),
    ...actorProfilePayload(input),
    org_id: input.orgId,
    workspace_id: input.workspaceId,
    host_id: input.hostId,
    role: input.role,
    access: input.access,
    backing: input.backing,
  })
    .setProtectedHeader(protectedHeader)
    .setIssuer(relayHostTokenIssuer)
    .setAudience(relayHostTokenAudience)
    .setSubject(input.subject)
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
  const sub = stringClaim(payload, "sub")
  const jti = stringClaim(payload, "jti")
  const org_id = stringClaim(payload, "org_id")
  const workspace_id = stringClaim(payload, "workspace_id")
  const host_id = stringClaim(payload, "host_id")
  const role = roleClaim(payload)
  const actor = actorClaims(payload)
  const actorProfile = actorProfileClaims(payload)
  if (!exp || !iat || !sub || !jti || !org_id || !workspace_id || !host_id || !role || !actor || !actorProfile) return
  return {
    iss: runtimeAccessTokenIssuer,
    aud: runtimeAccessTokenAudience,
    sub,
    org_id,
    workspace_id,
    host_id,
    role,
    ...actor,
    ...actorProfile,
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
  const access = stringClaim(payload, "access")
  const backing = stringClaim(payload, "backing")
  const pair = { access, backing }
  if (!base || !isRelayClaimPair(pair)) return
  return {
    ...base,
    iss: relayHostTokenIssuer,
    aud: relayHostTokenAudience,
    ...pair,
  }
}

function hostTunnelClaims(payload: JWTPayload): HostTunnelTokenClaims | undefined {
  const exp = numberClaim(payload, "exp")
  const iat = numberClaim(payload, "iat")
  const sub = stringClaim(payload, "sub")
  const jti = stringClaim(payload, "jti")
  const host_id = stringClaim(payload, "host_id")
  const workspace_ids = stringArrayClaim(payload, "workspace_ids")
  if (!exp || !iat || !sub || !jti || !host_id || !workspace_ids?.length) return
  return {
    iss: runtimeAccessTokenIssuer,
    aud: hostTunnelTokenAudience,
    sub,
    host_id,
    workspace_ids,
    exp,
    iat,
    jti,
  }
}
