import {
  createRemoteJWKSet,
  importJWK,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose"
import type { PrivateSessionRuntimePrincipal, RelayHostPrivateSessionClaims } from "@claxedo/server-core/platform/auth/private-session-authority"
import { SESSION_STREAM_LEASE_TTL_MS } from "@claxedo/workspace-relay-protocol"
import { trimToUndefined } from "@claxedo/helpers/string"
import { finiteTimestamp, positiveInteger } from "./runtime-authority-request"

/** The signed proofs the session authority mints for a runtime and reads back: stream leases, turn leases and the relay's host tokens. */
const streamLeaseIssuer = "claxedo-control-plane"
const streamLeaseAudience = "workspace-runtime-session-stream"
const turnLeaseIssuer = "claxedo-control-plane"
const turnLeaseAudience = "workspace-runtime-session-turn"

/**
 * How the runtime holding a lease proved its identity, and therefore what a
 * renewal re-checks. A relay host presents a Relay Host Token minted from a
 * durable Runtime Access Token, so every renewal re-checks that parent token
 * is still active. A workspace's own runtime presents the owner grant the
 * control plane launched it with, so every renewal re-resolves the
 * workspace's owner and refuses once the grant's actor is not that owner. An
 * embedded runtime runs inside the control plane process that mints the lease
 * and has no token chain of its own.
 */
export type SessionStreamLeaseBinding =
  | { transport: "relay-host"; hostId: string; parentRuntimeAccessTokenJti: string }
  | { transport: "owner-grant" }
  | { transport: "embedded" }

/**
 * A background turn redeeming the grant minted for it while its actor's
 * credential was live. It proves a turn and nothing else: the grant row is
 * rechecked by the turn authority inside the acquire, and a lease minted
 * from it renews on the authority's own share recheck, there being no
 * parent token or owner row behind it to re-resolve.
 */
export type DeferredGrantBinding = { transport: "deferred-grant"; grantId: string; hostId?: string }

export type SessionProofBinding = SessionStreamLeaseBinding | DeferredGrantBinding

/** The principal a proof or lease names, without the rest of its claims. */
export function sessionLeasePrincipal(claims: PrivateSessionRuntimePrincipal): PrivateSessionRuntimePrincipal {
  return claims.principalKind === "user"
    ? { principalKind: "user", actorId: claims.actorId, actorKind: "human" }
    : { principalKind: "service", actorId: claims.actorId, actorKind: "agent" }
}

export type SessionProofClaims = PrivateSessionRuntimePrincipal & SessionProofBinding & {
  orgId: string
  workspaceId: string
  sessionId: string
  action: "read" | "write"
}

export type SessionStreamLeaseClaims = PrivateSessionRuntimePrincipal & SessionStreamLeaseBinding & {
  orgId: string
  workspaceId: string
  /**
   * The session the lease is bound to, or `"*"`: a WORKSPACE stream lease,
   * minted by `host_read` for the runtime's unscoped `wr/events` arm, which
   * proves the reader's identity for every session that first appears on a
   * connection that outlives its one-request relay host token. It proves who
   * the reader is, never what they may read: each session is still authorized
   * on its own when the lease is presented for it.
   */
  sessionId: string
  action: "read" | "write"
}

export const WORKSPACE_STREAM_LEASE_SESSION = "*"

/** Prompt admission is reached over a proof a runtime presents, never from inside the plane's own process. */
export type TurnLeaseBinding = Exclude<SessionProofBinding, { transport: "embedded" }>

export type TurnLeaseClaims = Extract<SessionProofClaims, TurnLeaseBinding> & {
  turnId: string
  authorityLeaseId: string
  fencingToken: number
  acquiredAt: number
  expiresAt: number
}

export function streamLeaseMinter(env: Record<string, string | undefined>) {
  return async (claims: SessionStreamLeaseClaims) => {
    const pem = keyPem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM)
    if (!pem) throw new Error("Stream lease signing key is unavailable")
    const now = Math.floor(Date.now() / 1_000)
    const ttlSeconds = SESSION_STREAM_LEASE_TTL_MS / 1_000
    const expiresAt = (now + ttlSeconds) * 1_000
    const lease = await new SignJWT({
      principal_kind: claims.principalKind,
      actor_id: claims.actorId,
      actor_kind: claims.actorKind,
      org_id: claims.orgId,
      workspace_id: claims.workspaceId,
      transport: claims.transport,
      ...(claims.transport === "relay-host"
        ? { host_id: claims.hostId, parent_jti: claims.parentRuntimeAccessTokenJti }
        : {}),
      session_id: claims.sessionId,
      action: claims.action,
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(streamLeaseIssuer)
      .setAudience(streamLeaseAudience)
      .setIssuedAt(now)
      .setExpirationTime(now + ttlSeconds)
      .setJti(crypto.randomUUID())
      .sign(await importPKCS8(pem, "EdDSA"))
    return { lease, expiresAt }
  }
}

export function streamLeaseVerifier(env: Record<string, string | undefined>) {
  return async (lease: string): Promise<SessionStreamLeaseClaims> => {
    const pem = keyPem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM)
    if (!pem) throw new Error("Stream lease verification key is unavailable")
    const { payload } = await jwtVerify(lease, await importSPKI(pem, "EdDSA"), {
      algorithms: ["EdDSA"],
      issuer: streamLeaseIssuer,
      audience: streamLeaseAudience,
    })
    const principalKind = payload.principal_kind
    const actorKind = payload.actor_kind
    if (
      (principalKind !== "user" && principalKind !== "service")
      || (actorKind !== "human" && actorKind !== "agent")
      || (principalKind === "user" && actorKind !== "human")
      || (principalKind === "service" && actorKind !== "agent")
    ) throw new Error("Stream lease principal is invalid")
    const actorId = trimToUndefined(payload.actor_id)
    const orgId = trimToUndefined(payload.org_id)
    const workspaceId = trimToUndefined(payload.workspace_id)
    const hostId = trimToUndefined(payload.host_id)
    const parentRuntimeAccessTokenJti = trimToUndefined(payload.parent_jti)
    const sessionId = trimToUndefined(payload.session_id)
    const action = payload.action
    const transport = payload.transport
    if (!actorId || !orgId || !workspaceId || !sessionId
      || (action !== "read" && action !== "write")) throw new Error("Stream lease claims are invalid")
    const binding: SessionStreamLeaseBinding = transport === "embedded"
      ? { transport: "embedded" }
      : transport === "owner-grant"
        ? { transport: "owner-grant" }
        : transport === "relay-host" && hostId && parentRuntimeAccessTokenJti
          ? { transport: "relay-host", hostId, parentRuntimeAccessTokenJti }
          : (() => { throw new Error("Stream lease binding is invalid") })()
    const principal: PrivateSessionRuntimePrincipal = principalKind === "user"
      ? { principalKind: "user", actorId, actorKind: "human" }
      : { principalKind: "service", actorId, actorKind: "agent" }
    return {
      ...principal,
      ...binding,
      orgId,
      workspaceId,
      sessionId,
      action,
    }
  }
}

export function turnLeaseMinter(env: Record<string, string | undefined>) {
  return async (claims: TurnLeaseClaims) => {
    const pem = keyPem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM)
    if (!pem) throw new Error("Turn lease signing key is unavailable")
    const now = Math.floor(Date.now() / 1_000)
    const expiry = Math.floor(claims.expiresAt / 1_000)
    if (expiry <= now) throw new Error("Turn lease already expired before proof minting")
    const lease = await new SignJWT({
      principal_kind: claims.principalKind,
      actor_id: claims.actorId,
      actor_kind: claims.actorKind,
      org_id: claims.orgId,
      workspace_id: claims.workspaceId,
      transport: claims.transport,
      ...(claims.transport === "relay-host"
        ? { host_id: claims.hostId, parent_jti: claims.parentRuntimeAccessTokenJti }
        : claims.transport === "deferred-grant"
          ? { grant_id: claims.grantId, ...(claims.hostId ? { host_id: claims.hostId } : {}) }
          : {}),
      session_id: claims.sessionId,
      action: "write",
      turn_id: claims.turnId,
      authority_lease_id: claims.authorityLeaseId,
      fencing_token: claims.fencingToken,
      acquired_at: claims.acquiredAt,
      authority_expires_at: claims.expiresAt,
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(turnLeaseIssuer)
      .setAudience(turnLeaseAudience)
      .setIssuedAt(now)
      .setExpirationTime(expiry)
      .setJti(crypto.randomUUID())
      .sign(await importPKCS8(pem, "EdDSA"))
    return { lease, expiresAt: expiry * 1_000 }
  }
}

export function turnLeaseVerifier(env: Record<string, string | undefined>) {
  return async (lease: string): Promise<TurnLeaseClaims> => {
    const pem = keyPem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM)
    if (!pem) throw new Error("Turn lease verification key is unavailable")
    const { payload } = await jwtVerify(lease, await importSPKI(pem, "EdDSA"), {
      algorithms: ["EdDSA"],
      issuer: turnLeaseIssuer,
      audience: turnLeaseAudience,
    })
    const principalKind = payload.principal_kind
    const actorKind = payload.actor_kind
    if (
      (principalKind !== "user" && principalKind !== "service")
      || (actorKind !== "human" && actorKind !== "agent")
      || (principalKind === "user" && actorKind !== "human")
      || (principalKind === "service" && actorKind !== "agent")
    ) throw new Error("Turn lease principal is invalid")
    const actorId = trimToUndefined(payload.actor_id)
    const orgId = trimToUndefined(payload.org_id)
    const workspaceId = trimToUndefined(payload.workspace_id)
    const hostId = trimToUndefined(payload.host_id)
    const parentRuntimeAccessTokenJti = trimToUndefined(payload.parent_jti)
    const sessionId = trimToUndefined(payload.session_id)
    const turnId = trimToUndefined(payload.turn_id)
    const authorityLeaseId = trimToUndefined(payload.authority_lease_id)
    const fencingToken = positiveInteger(payload.fencing_token)
    const acquiredAt = finiteTimestamp(payload.acquired_at)
    const expiresAt = finiteTimestamp(payload.authority_expires_at)
    const grantId = trimToUndefined(payload.grant_id)
    const transport = payload.transport
    if (
      !actorId || !orgId || !workspaceId
      || !sessionId || !turnId || !authorityLeaseId || !fencingToken
      || acquiredAt === undefined || expiresAt === undefined || expiresAt <= acquiredAt
    ) throw new Error("Turn lease claims are invalid")
    const binding: TurnLeaseBinding = transport === "owner-grant"
      ? { transport: "owner-grant" }
      : transport === "relay-host" && hostId && parentRuntimeAccessTokenJti
        ? { transport: "relay-host", hostId, parentRuntimeAccessTokenJti }
        : transport === "deferred-grant" && grantId
          ? { transport: "deferred-grant", grantId, ...(hostId ? { hostId } : {}) }
          : (() => { throw new Error("Turn lease binding is invalid") })()
    const principal: PrivateSessionRuntimePrincipal = principalKind === "user"
      ? { principalKind: "user", actorId, actorKind: "human" }
      : { principalKind: "service", actorId, actorKind: "agent" }
    return {
      ...principal,
      ...binding,
      orgId,
      workspaceId,
      sessionId,
      action: "write",
      turnId,
      authorityLeaseId,
      fencingToken,
      acquiredAt,
      expiresAt,
    }
  }
}

type RelayProofKey = JWTVerifyGetKey
const relayKeys = new Map<string, RelayProofKey | Promise<RelayProofKey>>()

export function relayProofVerifier(env: Record<string, string | undefined>) {
  return async (token: string): Promise<RelayHostPrivateSessionClaims> => {
    const { payload } = await jwtVerify(token, await relayProofKey(env), {
      algorithms: ["EdDSA", "ES256", "RS256"],
      issuer: "workspace-relay",
      audience: "workspace-host-service",
    })
    const principalKind = payload.principal_kind
    const actorKind = payload.actor_kind
    const role = payload.role
    const backing = payload.backing
    const actorId = trimToUndefined(payload.actor_id)
    const orgId = trimToUndefined(payload.org_id)
    const workspaceId = trimToUndefined(payload.workspace_id)
    const hostId = trimToUndefined(payload.host_id)
    const jti = trimToUndefined(payload.jti)
    const parentJti = trimToUndefined(payload.parent_jti)
    const sessionScope = trimToUndefined(payload.session_id)
    if (
      (principalKind !== "user" && principalKind !== "service")
      || (actorKind !== "human" && actorKind !== "agent")
      || !actorId
      || !orgId
      || !workspaceId
      || !hostId
      || !jti
      || !parentJti
      || (role !== "viewer" && role !== "editor" && role !== "admin" && role !== "owner")
      || payload.access !== undefined
      || (payload.session_id !== undefined && !sessionScope)
      || (backing !== "cloud-vm" && backing !== "local-worktree" && backing !== "durable-object")
    ) throw new Error("Relay proof claims are invalid")
    // Assembled AFTER the checks so the claims object is the narrowed values,
    // not the raw payload asserted into their type.
    const claims: RelayHostPrivateSessionClaims = {
      principal_kind: principalKind,
      actor_id: actorId,
      actor_kind: actorKind,
      org_id: orgId,
      workspace_id: workspaceId,
      host_id: hostId,
      jti,
      parent_jti: parentJti,
      role,
      ...(sessionScope ? { session_id: sessionScope } : {}),
    }
    return claims
  }
}

function relayProofKey(env: Record<string, string | undefined>): RelayProofKey | Promise<RelayProofKey> {
  const jwksUrl = trimToUndefined(env.CLAXEDO_RELAY_JWKS_URL)
  if (jwksUrl) return cachedKey(`jwks:${jwksUrl}`, () => createRemoteJWKSet(new URL(jwksUrl)))
  const pem = keyPem(env.CLAXEDO_RELAY_HOST_VERIFY_PEM)
  if (pem) return cachedKey(`pem:${pem}`, () => async () => await importSPKI(pem, "EdDSA"))
  const jwk = trimToUndefined(env.CLAXEDO_RELAY_HOST_PUBLIC_KEY_JWK)
  if (jwk) return cachedKey(`jwk:${jwk}`, () => async () => await importJWK(JSON.parse(jwk), "EdDSA"))
  throw new Error("Relay proof verification is not configured")
}

function cachedKey(key: string, create: () => RelayProofKey | Promise<RelayProofKey>) {
  const existing = relayKeys.get(key)
  if (existing) return existing
  const value = create()
  relayKeys.set(key, value)
  return value
}

export function proofHost(claims: SessionProofClaims) {
  return claims.transport === "relay-host" || claims.transport === "deferred-grant" ? claims.hostId : undefined
}

function keyPem(value: string | undefined) {
  return trimToUndefined(value)?.replaceAll("\\n", "\n")
}
