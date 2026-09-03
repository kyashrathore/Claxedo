import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import {
  createRemoteJWKSet,
  importJWK,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose"
import { bearerToken, ControlPlaneAuthError, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import {
  privateSessionRuntimeProof,
  type PrivateSessionAuthority,
  type PrivateSessionRuntimePrincipal,
  type RelayHostPrivateSessionClaims,
} from "@claxedo/server-core/platform/auth/private-session-authority"
import {
  SessionTurnConflictError,
  SessionTurnLeaseLostError,
  type SessionTurnAuthority,
} from "@claxedo/server-core/platform/auth/session-turn-authority"
import { SESSION_STREAM_LEASE_TTL_MS } from "@claxedo/workspace-relay-protocol"

const bodyLimitBytes = 16 * 1024
const streamLeaseIssuer = "claxedo-control-plane"
const streamLeaseAudience = "workspace-runtime-session-stream"
const turnLeaseIssuer = "claxedo-control-plane"
const turnLeaseAudience = "workspace-runtime-session-turn"

type RuntimeSessionAuthorityPort = Pick<
  PrivateSessionAuthority,
  | "registerRuntimeSession"
  | "markSessionRegistrationAmbiguous"
  | "beginSessionCompensation"
  | "completeSessionCompensation"
  | "authorizeRuntimeSession"
> & {
  runtimeAccessTokenActive: (input: {
    jti: string
    workspaceId: string
    hostId: string
    minimumRole?: "viewer" | "editor" | "admin" | "owner"
  }) => Promise<unknown>
}

/**
 * How the runtime holding a lease proved its identity, and therefore what a
 * renewal re-checks. A relay host presents a Relay Host Token minted from a
 * durable Runtime Access Token, so every renewal re-checks that parent token
 * is still active. An embedded runtime runs inside the control plane process
 * that mints the lease and has no token chain of its own.
 */
export type SessionStreamLeaseBinding =
  | { transport: "relay-host"; hostId: string; parentRuntimeAccessTokenJti: string }
  | { transport: "embedded" }

export type SessionStreamLeaseClaims = PrivateSessionRuntimePrincipal & SessionStreamLeaseBinding & {
  orgId: string
  workspaceId: string
  sessionId: string
  action: "read" | "write"
}

/** Prompt admission is reached only over the Relay Host Token chain. */
type TurnLeaseClaims = Extract<SessionStreamLeaseClaims, { transport: "relay-host" }> & {
  turnId: string
  authorityLeaseId: string
  fencingToken: number
  acquiredAt: number
  expiresAt: number
}

export type RuntimeSessionStreamDecision =
  | { allowed: true; lease: string; expiresAt: number }
  | { allowed: false; status: 401; code: string; message: string }

export type RuntimeSessionStreamOptions = {
  authority: Pick<RuntimeSessionAuthorityPort, "authorizeRuntimeSession" | "runtimeAccessTokenActive">
  mintStreamLease?: (claims: SessionStreamLeaseClaims) => Promise<{ lease: string; expiresAt: number }>
  env?: Record<string, string | undefined>
}

/**
 * The one owner of "may this principal keep a live stream on this session,
 * and what proof carries it until the next renewal".
 *
 * `RuntimeSessionAuthorityRoutes` serves it over HTTP to isolated runtimes;
 * the self-hosted composition calls it in process for its embedded runtime.
 * Both re-run it on every renewal, so a revoked participant or a revoked
 * parent token ends the stream at the next refresh. A denial from the
 * private-session authority itself surfaces as the `ControlPlaneAuthError`
 * that authority throws.
 */
export async function authorizeRuntimeSessionStream(
  options: RuntimeSessionStreamOptions,
  claims: SessionStreamLeaseClaims,
): Promise<RuntimeSessionStreamDecision> {
  const denial = await runtimeAccessTokenDenial(options.authority, claims)
  if (denial) return { allowed: false, status: 401, ...denial }
  await options.authority.authorizeRuntimeSession({
    ...sessionLeasePrincipal(claims),
    sessionId: claims.sessionId,
    workspaceId: claims.workspaceId,
    action: claims.action,
  })
  const minter = options.mintStreamLease ?? streamLeaseMinter(options.env ?? process.env)
  return { allowed: true, ...await minter(claims) }
}

/** Verifies a lease this control plane minted and returns its bound claims. */
export function sessionStreamLeaseVerifier(env: Record<string, string | undefined> = process.env) {
  return streamLeaseVerifier(env)
}

function sessionLeasePrincipal(claims: SessionStreamLeaseClaims): PrivateSessionRuntimePrincipal {
  return claims.principalKind === "user"
    ? { principalKind: "user", actorId: claims.actorId, actorKind: "human" }
    : { principalKind: "service", actorId: claims.actorId, actorKind: "agent" }
}

async function runtimeAccessTokenDenial(
  authority: Pick<RuntimeSessionAuthorityPort, "runtimeAccessTokenActive">,
  claims: SessionStreamLeaseClaims,
) {
  if (claims.transport !== "relay-host") return
  const active = asRecord(await authority.runtimeAccessTokenActive({
    jti: claims.parentRuntimeAccessTokenJti,
    workspaceId: claims.workspaceId,
    hostId: claims.hostId,
  }))
  if (active?.active === true) return
  return {
    code: text(active?.code) ?? "runtime_access_token_inactive",
    message: text(active?.reason) ?? "Runtime Access Token is inactive",
  }
}

export type RuntimeSessionAuthorityOptions = {
  authority: RuntimeSessionAuthorityPort
  /** Durable prompt admission is selected independently from session visibility. */
  turnAuthority?: SessionTurnAuthority
  env?: Record<string, string | undefined>
  verifyRelayProof?: (token: string) => Promise<RelayHostPrivateSessionClaims>
  mintStreamLease?: (claims: SessionStreamLeaseClaims) => Promise<{ lease: string; expiresAt: number }>
  verifyStreamLease?: (lease: string) => Promise<SessionStreamLeaseClaims>
  mintTurnLease?: (claims: TurnLeaseClaims) => Promise<{ lease: string; expiresAt: number }>
  verifyTurnLease?: (lease: string) => Promise<TurnLeaseClaims>
}

/**
 * Narrow provider-neutral oracle for isolated workspace runtimes.
 *
 * Identity comes only from a verified RHT (or a short lease minted from one),
 * never from request JSON. Every stream renewal checks the durable parent RAT
 * and current private-session membership before issuing another lease.
 */
export function RuntimeSessionAuthorityRoutes(options: RuntimeSessionAuthorityOptions) {
  const env = options.env ?? process.env
  const limitedBody = bodyLimit({
    maxSize: bodyLimitBytes,
    onError: (context) => context.json({
      error: {
        code: "request_body_too_large",
        message: `Request body exceeds the ${bodyLimitBytes}-byte limit`,
      },
    }, 413),
  })

  return new Hono().post("/session-authorize", limitedBody, async (context) => {
    const body = await context.req.json().catch(() => undefined) as Record<string, unknown> | undefined
    const sessionId = text(body?.sessionId)
    const action = body?.action
    const operationId = text(body?.operationId)
    const reason = optionalText(body?.reason)
    const title = optionalText(body?.title)
    const stream = body?.stream === true
    const lease = text(body?.lease)
    const turnId = text(body?.turnId)
    const turnLeaseId = text(body?.leaseId)
    const fencingToken = positiveInteger(body?.fencingToken)
    if (isHostAuthorityAction(action)) {
      if (body && Object.keys(body).some((key) => key !== "action")) {
        return context.json({
          error: { code: "host_authority_request_invalid", message: "Host authority accepts only its action" },
        }, 400)
      }
      const token = bearerToken(context.req.header("authorization") ?? null)
      if (!token) {
        return context.json({ error: { code: "relay_host_token_required", message: "Relay Host Token is required" } }, 401)
      }
      const verified = await (options.verifyRelayProof ?? relayProofVerifier(env))(token).catch(() => undefined)
      if (!verified) {
        return context.json({ error: { code: "relay_host_token_invalid", message: "Relay Host Token is invalid or expired" } }, 401)
      }
      const minimumRole = action === "host_admin" ? "admin" as const : "viewer" as const
      if (!verified.role || roleRank(verified.role) < roleRank(minimumRole)) {
        return context.json({
          error: { code: "host_authority_denied", message: `Workspace ${minimumRole} authority is required` },
        }, 403)
      }
      const proof = privateSessionRuntimeProof(verified)
      const active = asRecord(await options.authority.runtimeAccessTokenActive({
        jti: proof.parentRuntimeAccessTokenJti,
        workspaceId: proof.workspaceId,
        hostId: proof.hostId,
        minimumRole,
      }))
      if (active?.active !== true) {
        return context.json({
          error: {
            code: text(active?.code) ?? "runtime_access_token_inactive",
            message: text(active?.reason) ?? "Runtime Access Token is inactive",
          },
        }, 401)
      }
      return context.json({ allowed: true })
    }
    if (
      !sessionId
      || !isAuthorityAction(action)
      || (isRegistrationAction(action) && !operationId)
      || (isTransitionAction(action) && !reason)
      || (body?.title !== undefined && title === undefined)
      || (body?.reason !== undefined && reason === undefined)
      || (body?.stream !== undefined && typeof body.stream !== "boolean")
      || (body?.lease !== undefined && !lease)
      || (!!lease && !stream)
      || (stream && action !== "read" && action !== "write")
      || (isTurnAction(action) && !turnId)
      || ((action === "turn_renew" || action === "turn_release") && (!turnLeaseId || !fencingToken))
      || (action === "turn_acquire" && (body?.leaseId !== undefined || body?.fencingToken !== undefined))
    ) {
      return context.json({
        error: {
          code: "session_authority_request_invalid",
          message: "sessionId, action, and exact registration operation fields are required",
        },
      }, 400)
    }

    let claims: SessionStreamLeaseClaims
    let ownedTurn: TurnLeaseClaims | undefined
    if ((action === "turn_renew" || action === "turn_release") && turnLeaseId) {
      const verified = await (options.verifyTurnLease ?? turnLeaseVerifier(env))(turnLeaseId).catch(() => undefined)
      if (
        !verified
        || verified.sessionId !== sessionId
        || verified.turnId !== turnId
        || verified.fencingToken !== fencingToken
      ) {
        return context.json({
          error: { code: "session_turn_lease_invalid", message: "Session turn lease is invalid or mismatched" },
        }, 401)
      }
      ownedTurn = verified
      claims = verified
    } else if (lease) {
      const verified = await (options.verifyStreamLease ?? streamLeaseVerifier(env))(lease).catch(() => undefined)
      if (!verified || verified.sessionId !== sessionId || verified.action !== action) {
        return context.json({
          error: { code: "session_stream_lease_invalid", message: "Session stream lease is invalid or mismatched" },
        }, 401)
      }
      claims = verified
    } else {
      const token = bearerToken(context.req.header("authorization") ?? null)
      if (!token) {
        return context.json({ error: { code: "relay_host_token_required", message: "Relay Host Token is required" } }, 401)
      }
      const verified = await (options.verifyRelayProof ?? relayProofVerifier(env))(token).catch(() => undefined)
      if (!verified) {
        return context.json({
          error: { code: "relay_host_token_invalid", message: "Relay Host Token is invalid or expired" },
        }, 401)
      }
      try {
        const proof = privateSessionRuntimeProof(verified)
        const principal: PrivateSessionRuntimePrincipal = proof.principalKind === "user"
          ? { principalKind: "user", actorId: proof.actorId, actorKind: "human" }
          : { principalKind: "service", actorId: proof.actorId, actorKind: "agent" }
        claims = {
          ...principal,
          transport: "relay-host",
          orgId: proof.orgId,
          workspaceId: proof.workspaceId,
          hostId: proof.hostId,
          parentRuntimeAccessTokenJti: proof.parentRuntimeAccessTokenJti,
          sessionId,
          action: action === "write" ? "write" : "read",
        }
      } catch {
        return context.json({
          error: { code: "relay_host_token_invalid", message: "Relay Host Token claims are invalid" },
        }, 401)
      }
    }

    try {
      const principal = sessionLeasePrincipal(claims)
      if (action === "register") {
        await options.authority.registerRuntimeSession({
          ...principal,
          operationId: operationId!,
          sessionId,
          workspaceId: claims.workspaceId,
          ...(title ? { title } : {}),
        })
        return context.json({ allowed: true })
      }
      if (isTransitionAction(action)) {
        const input = {
          ...principal,
          operationId: operationId!,
          sessionId,
          workspaceId: claims.workspaceId,
          reason: reason!,
        }
        if (action === "registration_ambiguous") {
          await options.authority.markSessionRegistrationAmbiguous(input)
        } else if (action === "compensation_begin") {
          await options.authority.beginSessionCompensation(input)
        } else {
          await options.authority.completeSessionCompensation(input)
        }
        return context.json({ allowed: true })
      }

      if (isTurnAction(action)) {
        // Turn admission is reached only over the Relay Host Token chain: the
        // request validation above accepts a lease only together with
        // `stream`, and `stream` is only ever a read/write action.
        if (claims.transport !== "relay-host") {
          return context.json({
            error: {
              code: "session_turn_lease_invalid",
              message: "Session turn admission requires a Relay Host Token chain",
            },
          }, 401)
        }
        const denial = await runtimeAccessTokenDenial(options.authority, claims)
        if (denial) return context.json({ error: denial }, 401)
        if (!options.turnAuthority) {
          return context.json({
            error: {
              code: "session_turn_authority_unavailable",
              message: "Durable session turn authority is not configured",
            },
          }, 503)
        }
        const turn = {
          ...principal,
          sessionId,
          workspaceId: claims.workspaceId,
          turnId: turnId!,
        }
        if (action === "turn_acquire") {
          const acquired = await options.turnAuthority.acquireSessionTurn(turn)
          const proof = await (options.mintTurnLease ?? turnLeaseMinter(env))({
            ...claims,
            action: "write",
            turnId: acquired.turnId,
            authorityLeaseId: acquired.leaseId,
            fencingToken: acquired.fencingToken,
            acquiredAt: acquired.acquiredAt,
            expiresAt: acquired.expiresAt,
          })
          return context.json({ ...acquired, leaseId: proof.lease, expiresAt: proof.expiresAt })
        }
        const owned = {
          ...turn,
          leaseId: ownedTurn!.authorityLeaseId,
          fencingToken: ownedTurn!.fencingToken,
        }
        if (action === "turn_renew") {
          const renewed = await options.turnAuthority.renewSessionTurn(owned)
          const proof = await (options.mintTurnLease ?? turnLeaseMinter(env))({
            ...ownedTurn!,
            authorityLeaseId: renewed.leaseId,
            fencingToken: renewed.fencingToken,
            acquiredAt: renewed.acquiredAt,
            expiresAt: renewed.expiresAt,
          })
          return context.json({ ...renewed, leaseId: proof.lease, expiresAt: proof.expiresAt })
        }
        return context.json(await options.turnAuthority.releaseSessionTurn(owned))
      }

      if (stream) {
        const decision = await authorizeRuntimeSessionStream({
          authority: options.authority,
          ...(options.mintStreamLease ? { mintStreamLease: options.mintStreamLease } : {}),
          env,
        }, claims)
        if (!decision.allowed) {
          return context.json({ error: { code: decision.code, message: decision.message } }, decision.status)
        }
        return context.json({ allowed: true, lease: decision.lease, expiresAt: decision.expiresAt })
      }
      await options.authority.authorizeRuntimeSession({
        ...principal,
        sessionId,
        workspaceId: claims.workspaceId,
        action,
      })
      return context.json({ allowed: true })
    } catch (error) {
      if (error instanceof SessionTurnConflictError || error instanceof SessionTurnLeaseLostError) {
        return context.json({
          error: {
            code: error.code,
            message: error.message,
            ...(error instanceof SessionTurnConflictError && error.activeUntil !== undefined
              ? { activeUntil: error.activeUntil }
              : {}),
          },
        }, 409)
      }
      if (error instanceof ControlPlaneAuthError) {
        return context.json(controlPlaneAuthErrorBody(error), error.status as 401 | 403 | 503)
      }
      return context.json({
        error: { code: "session_authority_unavailable", message: "Session authority is temporarily unavailable" },
      }, 503)
    }
  })
}

type AuthorityAction =
  | "read"
  | "write"
  | "register"
  | "registration_ambiguous"
  | "compensation_begin"
  | "compensation_complete"
  | "turn_acquire"
  | "turn_renew"
  | "turn_release"

type HostAuthorityAction = "host_read" | "host_admin"

function isHostAuthorityAction(value: unknown): value is HostAuthorityAction {
  return value === "host_read" || value === "host_admin"
}

function isAuthorityAction(value: unknown): value is AuthorityAction {
  return value === "read"
    || value === "write"
    || value === "register"
    || value === "registration_ambiguous"
    || value === "compensation_begin"
    || value === "compensation_complete"
    || value === "turn_acquire"
    || value === "turn_renew"
    || value === "turn_release"
}

function isTransitionAction(value: AuthorityAction): value is Exclude<AuthorityAction, "read" | "write" | "register"> {
  return value === "registration_ambiguous" || value === "compensation_begin" || value === "compensation_complete"
}

function isRegistrationAction(value: AuthorityAction) {
  return value === "register" || isTransitionAction(value)
}

function isTurnAction(value: AuthorityAction): value is "turn_acquire" | "turn_renew" | "turn_release" {
  return value === "turn_acquire" || value === "turn_renew" || value === "turn_release"
}

function streamLeaseMinter(env: Record<string, string | undefined>) {
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

function streamLeaseVerifier(env: Record<string, string | undefined>) {
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
    const actorId = text(payload.actor_id)
    const orgId = text(payload.org_id)
    const workspaceId = text(payload.workspace_id)
    const hostId = text(payload.host_id)
    const parentRuntimeAccessTokenJti = text(payload.parent_jti)
    const sessionId = text(payload.session_id)
    const action = payload.action
    const transport = payload.transport
    if (!actorId || !orgId || !workspaceId || !sessionId
      || (action !== "read" && action !== "write")) throw new Error("Stream lease claims are invalid")
    const binding: SessionStreamLeaseBinding = transport === "embedded"
      ? { transport: "embedded" }
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

function turnLeaseMinter(env: Record<string, string | undefined>) {
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
      host_id: claims.hostId,
      parent_jti: claims.parentRuntimeAccessTokenJti,
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

function turnLeaseVerifier(env: Record<string, string | undefined>) {
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
    const actorId = text(payload.actor_id)
    const orgId = text(payload.org_id)
    const workspaceId = text(payload.workspace_id)
    const hostId = text(payload.host_id)
    const parentRuntimeAccessTokenJti = text(payload.parent_jti)
    const sessionId = text(payload.session_id)
    const turnId = text(payload.turn_id)
    const authorityLeaseId = text(payload.authority_lease_id)
    const fencingToken = positiveInteger(payload.fencing_token)
    const acquiredAt = finiteTimestamp(payload.acquired_at)
    const expiresAt = finiteTimestamp(payload.authority_expires_at)
    if (
      !actorId || !orgId || !workspaceId || !hostId || !parentRuntimeAccessTokenJti
      || !sessionId || !turnId || !authorityLeaseId || !fencingToken
      || acquiredAt === undefined || expiresAt === undefined || expiresAt <= acquiredAt
    ) throw new Error("Turn lease claims are invalid")
    const principal: PrivateSessionRuntimePrincipal = principalKind === "user"
      ? { principalKind: "user", actorId, actorKind: "human" }
      : { principalKind: "service", actorId, actorKind: "agent" }
    return {
      ...principal,
      transport: "relay-host",
      orgId,
      workspaceId,
      hostId,
      parentRuntimeAccessTokenJti,
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
    const access = payload.access
    const backing = payload.backing
    const claims = {
      principal_kind: principalKind,
      actor_id: text(payload.actor_id),
      actor_kind: actorKind,
      org_id: text(payload.org_id),
      workspace_id: text(payload.workspace_id),
      host_id: text(payload.host_id),
      jti: text(payload.jti),
      parent_jti: text(payload.parent_jti),
      role,
    }
    if (
      (principalKind !== "user" && principalKind !== "service")
      || (actorKind !== "human" && actorKind !== "agent")
      || !claims.actor_id
      || !claims.org_id
      || !claims.workspace_id
      || !claims.host_id
      || !claims.jti
      || !claims.parent_jti
      || (role !== "viewer" && role !== "editor" && role !== "admin" && role !== "owner")
      || !((access === "cloud" && backing === "cloud-vm")
        || (access === "user-hosted" && backing === "local-worktree"))
    ) throw new Error("Relay proof claims are invalid")
    return claims as RelayHostPrivateSessionClaims
  }
}

function roleRank(role: "viewer" | "editor" | "admin" | "owner") {
  return role === "viewer" ? 0 : role === "editor" ? 1 : role === "admin" ? 2 : 3
}

function relayProofKey(env: Record<string, string | undefined>): RelayProofKey | Promise<RelayProofKey> {
  const jwksUrl = text(env.CLAXEDO_RELAY_JWKS_URL)
  if (jwksUrl) return cachedKey(`jwks:${jwksUrl}`, () => createRemoteJWKSet(new URL(jwksUrl)))
  const pem = keyPem(env.CLAXEDO_RELAY_HOST_VERIFY_PEM)
  if (pem) return cachedKey(`pem:${pem}`, () => async () => await importSPKI(pem, "EdDSA"))
  const jwk = text(env.CLAXEDO_RELAY_HOST_PUBLIC_KEY_JWK)
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

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function optionalText(value: unknown) {
  if (value === undefined) return ""
  return text(value)
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function finiteTimestamp(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function keyPem(value: string | undefined) {
  return text(value)?.replaceAll("\\n", "\n")
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
