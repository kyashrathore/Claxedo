import { Hono } from "hono"
import {
  createRemoteJWKSet,
  importJWK,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  type JWTVerifyGetKey,
} from "jose"
import type { RelayHostTokenClaims } from "@claxedo/workspace-relay"
import type { ControlPlaneServices } from "../authority/services"
import { bearerToken, ControlPlaneAuthError, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"

type RelayProofKey = JWTVerifyGetKey

type StreamLeaseClaims = {
  actorId: string
  actorKind: "human" | "agent"
  orgId: string
  workspaceId: string
  hostId: string
  parentJti: string
  sessionId: string
  action: "read" | "write"
}

export type RuntimeSessionAuthorityOptions = {
  env?: Record<string, string | undefined>
  verifyRelayProof?: (token: string) => Promise<RelayHostTokenClaims>
  mintStreamLease?: (claims: StreamLeaseClaims) => Promise<{ lease: string; expiresAt: number }>
  verifyStreamLease?: (lease: string) => Promise<StreamLeaseClaims>
}

/**
 * Narrow authority oracle used by isolated workspace runtimes. The presented
 * proof is an RHT that the runtime already verified at request establishment;
 * this endpoint verifies the relay signature again and derives actor/workspace
 * identity exclusively from those signed claims.
 *
 * RHT expiry is enforced at connection establishment. Long-lived transports
 * then renew a short control-plane lease whose parent is the durable RAT jti;
 * each renewal checks both RAT revocation and current session authority.
 */
export function RuntimeSessionAuthorityRoutes(
  services?: ControlPlaneServices,
  options: RuntimeSessionAuthorityOptions = {},
) {
  return new Hono().post("/session-authorize", async (c) => {
    const body = await c.req.json().catch(() => undefined) as {
      sessionId?: unknown
      action?: unknown
      title?: unknown
      stream?: unknown
      lease?: unknown
    } | undefined
    if (
      typeof body?.sessionId !== "string"
      || !body.sessionId.trim()
      || !["read", "write", "register"].includes(String(body.action))
      || (body.title !== undefined && typeof body.title !== "string")
      || (body.stream !== undefined && typeof body.stream !== "boolean")
      || (body.lease !== undefined && typeof body.lease !== "string")
      || (body.lease !== undefined && body.stream !== true)
      || (body.stream === true && body.action === "register")
    ) {
      return c.json({ error: { code: "session_authority_request_invalid", message: "sessionId and a valid action are required" } }, 400)
    }
    const env = options.env ?? process.env
    const streamClaims = typeof body.lease === "string"
      ? await (options.verifyStreamLease ?? streamLeaseVerifier(env))(body.lease).catch(() => undefined)
      : undefined
    const token = bearerToken(c.req.header("authorization") ?? null)
    if (!streamClaims && !token) {
      return c.json({ error: { code: "relay_host_token_required", message: "Relay Host Token is required" } }, 401)
    }
    const relayClaims = streamClaims
      ? undefined
      : await (options.verifyRelayProof ?? relayProofVerifier(env))(token!).catch(() => undefined)
    if (!streamClaims && !relayClaims) {
      return c.json({ error: { code: "relay_host_token_invalid", message: "Relay Host Token is invalid or expired" } }, 401)
    }
    if (streamClaims && (streamClaims.sessionId !== body.sessionId || streamClaims.action !== body.action)) {
      return c.json({ error: { code: "session_stream_lease_mismatch", message: "Session stream lease does not match the request" } }, 401)
    }
    if (relayClaims && (!("actor_id" in relayClaims) || !("actor_kind" in relayClaims))) {
      return c.json({ error: { code: "session_actor_required", message: "Verified actor claims are required" } }, 403)
    }
    const attributedRelayClaims = relayClaims as (RelayHostTokenClaims & {
      actor_id: string
      actor_kind: "human" | "agent"
    }) | undefined
    const claims: StreamLeaseClaims = streamClaims ?? {
      actorId: attributedRelayClaims!.actor_id,
      actorKind: attributedRelayClaims!.actor_kind,
      orgId: attributedRelayClaims!.org_id,
      workspaceId: attributedRelayClaims!.workspace_id,
      hostId: attributedRelayClaims!.host_id,
      parentJti: attributedRelayClaims!.jti,
      sessionId: body.sessionId,
      action: body.action as "read" | "write",
    }
    try {
      const authority = requireAuthority(services)
      if (body.action === "register") {
        if (!authority.registerRuntimeSession) throw new Error("runtime session registration is unavailable")
        await authority.registerRuntimeSession({
          actorId: claims.actorId,
          actorKind: claims.actorKind,
          sessionId: body.sessionId,
          workspaceId: claims.workspaceId,
          ...(typeof body.title === "string" && body.title.trim() ? { title: body.title.trim() } : {}),
        })
        return c.json({ allowed: true })
      }
      if (body.stream === true) {
        if (!authority.runtimeAccessTokenActive) throw new Error("runtime token authority is unavailable")
        const active = await authority.runtimeAccessTokenActive({
          jti: claims.parentJti,
          workspaceId: claims.workspaceId,
          hostId: claims.hostId,
        }) as { active?: unknown; code?: unknown; reason?: unknown }
        if (active.active !== true) {
          return c.json({
            error: {
              code: typeof active.code === "string" ? active.code : "runtime_access_token_inactive",
              message: typeof active.reason === "string" ? active.reason : "Runtime Access Token is inactive",
            },
          }, 401)
        }
      }
      if (!authority.authorizeRuntimeSession) throw new Error("runtime session authority is unavailable")
      await authority.authorizeRuntimeSession({
        actorId: claims.actorId,
        actorKind: claims.actorKind,
        sessionId: body.sessionId,
        workspaceId: claims.workspaceId,
        action: body.action as "read" | "write",
      })
      if (body.stream === true) {
        const minted = await (options.mintStreamLease ?? streamLeaseMinter(env))(claims)
        return c.json({ allowed: true, ...minted })
      }
      return c.json({ allowed: true })
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) {
        return c.json(controlPlaneAuthErrorBody(error), error.status as 401 | 403 | 503)
      }
      return c.json({ error: { code: "session_authority_unavailable", message: "Session authority is temporarily unavailable" } }, 503)
    }
  })
}

const streamLeaseIssuer = "claxedo-control-plane"
const streamLeaseAudience = "workspace-runtime-session-stream"
const streamLeaseTtlSeconds = 15

function streamLeaseMinter(env: Record<string, string | undefined>) {
  return async (claims: StreamLeaseClaims) => {
    const pem = env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM?.replaceAll("\\n", "\n").trim()
    if (!pem) throw new Error("stream lease signing key is unavailable")
    const now = Math.floor(Date.now() / 1_000)
    const expiresAt = (now + streamLeaseTtlSeconds) * 1_000
    const lease = await new SignJWT({
      actor_id: claims.actorId,
      actor_kind: claims.actorKind,
      org_id: claims.orgId,
      workspace_id: claims.workspaceId,
      host_id: claims.hostId,
      parent_jti: claims.parentJti,
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
    const pem = env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM?.replaceAll("\\n", "\n").trim()
    if (!pem) throw new Error("stream lease verification key is unavailable")
    const { payload } = await jwtVerify(lease, await importSPKI(pem, "EdDSA"), {
      algorithms: ["EdDSA"],
      issuer: streamLeaseIssuer,
      audience: streamLeaseAudience,
    })
    if (
      typeof payload.actor_id !== "string"
      || !["human", "agent"].includes(String(payload.actor_kind))
      || typeof payload.org_id !== "string"
      || typeof payload.workspace_id !== "string"
      || typeof payload.host_id !== "string"
      || typeof payload.parent_jti !== "string"
      || typeof payload.session_id !== "string"
      || !["read", "write"].includes(String(payload.action))
    ) throw new Error("stream lease claims are invalid")
    return {
      actorId: payload.actor_id,
      actorKind: payload.actor_kind as "human" | "agent",
      orgId: payload.org_id,
      workspaceId: payload.workspace_id,
      hostId: payload.host_id,
      parentJti: payload.parent_jti,
      sessionId: payload.session_id,
      action: payload.action as "read" | "write",
    }
  }
}

const relayKeys = new Map<string, RelayProofKey | Promise<RelayProofKey>>()

function relayProofVerifier(env: Record<string, string | undefined>) {
  return async (token: string) => {
    const result = await jwtVerify(token, await relayProofKey(env), {
      algorithms: ["EdDSA", "ES256", "RS256"],
      issuer: "workspace-relay",
      audience: "workspace-host-service",
    })
    const claims = result.payload
    if (
      typeof claims.sub !== "string"
      || typeof claims.org_id !== "string"
      || typeof claims.workspace_id !== "string"
      || typeof claims.host_id !== "string"
      || typeof claims.jti !== "string"
      || typeof claims.exp !== "number"
      || typeof claims.iat !== "number"
      || !["viewer", "editor", "admin", "owner"].includes(String(claims.role))
      || !((claims.access === "cloud" && claims.backing === "cloud-vm")
        || (claims.access === "user-hosted" && claims.backing === "local-worktree"))
      || !((typeof claims.actor_id === "string" && ["human", "agent"].includes(String(claims.actor_kind)))
        || (claims.actor_id === undefined && claims.actor_kind === undefined))
    ) throw new Error("relay proof claims are invalid")
    return claims as RelayHostTokenClaims
  }
}

function relayProofKey(env: Record<string, string | undefined>): RelayProofKey | Promise<RelayProofKey> {
  const jwksUrl = env.CLAXEDO_RELAY_JWKS_URL?.trim()
  if (jwksUrl) return cachedKey(`jwks:${jwksUrl}`, () => createRemoteJWKSet(new URL(jwksUrl)))
  const pem = env.CLAXEDO_RELAY_HOST_VERIFY_PEM?.trim()
  if (pem) return cachedKey(`pem:${pem}`, () => async () => await importSPKI(pem, "EdDSA"))
  const jwk = env.CLAXEDO_RELAY_HOST_PUBLIC_KEY_JWK?.trim()
  if (jwk) return cachedKey(`jwk:${jwk}`, () => async () => await importJWK(JSON.parse(jwk), "EdDSA"))
  throw new Error("relay proof verification is not configured")
}

function cachedKey(key: string, create: () => RelayProofKey | Promise<RelayProofKey>) {
  const existing = relayKeys.get(key)
  if (existing) return existing
  const value = create()
  relayKeys.set(key, value)
  return value
}
