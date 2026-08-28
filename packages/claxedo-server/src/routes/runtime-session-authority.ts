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

const bodyLimitBytes = 16 * 1024
const streamLeaseIssuer = "claxedo-control-plane"
const streamLeaseAudience = "workspace-runtime-session-stream"
const streamLeaseTtlSeconds = 15

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
  }) => Promise<unknown>
}

type StreamLeaseClaims = PrivateSessionRuntimePrincipal & {
  orgId: string
  workspaceId: string
  hostId: string
  parentRuntimeAccessTokenJti: string
  sessionId: string
  action: "read" | "write"
}

export type RuntimeSessionAuthorityOptions = {
  authority: RuntimeSessionAuthorityPort
  env?: Record<string, string | undefined>
  verifyRelayProof?: (token: string) => Promise<RelayHostPrivateSessionClaims>
  mintStreamLease?: (claims: StreamLeaseClaims) => Promise<{ lease: string; expiresAt: number }>
  verifyStreamLease?: (lease: string) => Promise<StreamLeaseClaims>
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
    ) {
      return context.json({
        error: {
          code: "session_authority_request_invalid",
          message: "sessionId, action, and exact registration operation fields are required",
        },
      }, 400)
    }

    let claims: StreamLeaseClaims
    if (lease) {
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
      const principal: PrivateSessionRuntimePrincipal = claims.principalKind === "user"
        ? { principalKind: "user", actorId: claims.actorId, actorKind: "human" }
        : { principalKind: "service", actorId: claims.actorId, actorKind: "agent" }
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

      if (stream) {
        const active = asRecord(await options.authority.runtimeAccessTokenActive({
          jti: claims.parentRuntimeAccessTokenJti,
          workspaceId: claims.workspaceId,
          hostId: claims.hostId,
        }))
        if (active?.active !== true) {
          return context.json({
            error: {
              code: text(active?.code) ?? "runtime_access_token_inactive",
              message: text(active?.reason) ?? "Runtime Access Token is inactive",
            },
          }, 401)
        }
      }

      await options.authority.authorizeRuntimeSession({
        ...principal,
        sessionId,
        workspaceId: claims.workspaceId,
        action,
      })
      if (!stream) return context.json({ allowed: true })
      return context.json({
        allowed: true,
        ...await (options.mintStreamLease ?? streamLeaseMinter(env))(claims),
      })
    } catch (error) {
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

function isAuthorityAction(value: unknown): value is AuthorityAction {
  return value === "read"
    || value === "write"
    || value === "register"
    || value === "registration_ambiguous"
    || value === "compensation_begin"
    || value === "compensation_complete"
}

function isTransitionAction(value: AuthorityAction): value is Exclude<AuthorityAction, "read" | "write" | "register"> {
  return value === "registration_ambiguous" || value === "compensation_begin" || value === "compensation_complete"
}

function isRegistrationAction(value: AuthorityAction) {
  return value === "register" || isTransitionAction(value)
}

function streamLeaseMinter(env: Record<string, string | undefined>) {
  return async (claims: StreamLeaseClaims) => {
    const pem = keyPem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM)
    if (!pem) throw new Error("Stream lease signing key is unavailable")
    const now = Math.floor(Date.now() / 1_000)
    const expiresAt = (now + streamLeaseTtlSeconds) * 1_000
    const lease = await new SignJWT({
      principal_kind: claims.principalKind,
      actor_id: claims.actorId,
      actor_kind: claims.actorKind,
      org_id: claims.orgId,
      workspace_id: claims.workspaceId,
      host_id: claims.hostId,
      parent_jti: claims.parentRuntimeAccessTokenJti,
      session_id: claims.sessionId,
      action: claims.action,
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(streamLeaseIssuer)
      .setAudience(streamLeaseAudience)
      .setIssuedAt(now)
      .setExpirationTime(now + streamLeaseTtlSeconds)
      .setJti(crypto.randomUUID())
      .sign(await importPKCS8(pem, "EdDSA"))
    return { lease, expiresAt }
  }
}

function streamLeaseVerifier(env: Record<string, string | undefined>) {
  return async (lease: string): Promise<StreamLeaseClaims> => {
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
    if (!actorId || !orgId || !workspaceId || !hostId || !parentRuntimeAccessTokenJti || !sessionId
      || (action !== "read" && action !== "write")) throw new Error("Stream lease claims are invalid")
    const principal: PrivateSessionRuntimePrincipal = principalKind === "user"
      ? { principalKind: "user", actorId, actorKind: "human" }
      : { principalKind: "service", actorId, actorKind: "agent" }
    return {
      ...principal,
      orgId,
      workspaceId,
      hostId,
      parentRuntimeAccessTokenJti,
      sessionId,
      action,
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

function keyPem(value: string | undefined) {
  return text(value)?.replaceAll("\\n", "\n")
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
