import { Hono } from "hono"
import {
  createRemoteJWKSet,
  importJWK,
  importSPKI,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose"
import type { RelayHostTokenClaims } from "@claxedo/workspace-relay"
import type { ControlPlaneServices } from "../authority/services"
import { bearerToken, ControlPlaneAuthError, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"

type RelayProofKey = JWTVerifyGetKey

export type RuntimeSessionAuthorityOptions = {
  env?: Record<string, string | undefined>
  verifyRelayProof?: (token: string) => Promise<RelayHostTokenClaims>
}

/**
 * Narrow authority oracle used by isolated workspace runtimes. The presented
 * proof is an RHT that the runtime already verified at request establishment;
 * this endpoint verifies the relay signature again and derives actor/workspace
 * identity exclusively from those signed claims.
 *
 * RHT expiry is enforced on every lookup. A long-lived SSE connection whose
 * proof expires is terminated before the next session-derived event; the
 * client reconnect path obtains a fresh RAT/RHT and resumes from Last-Event-ID.
 */
export function RuntimeSessionAuthorityRoutes(
  services?: ControlPlaneServices,
  options: RuntimeSessionAuthorityOptions = {},
) {
  return new Hono().post("/session-authorize", async (c) => {
    const token = bearerToken(c.req.header("authorization") ?? null)
    if (!token) {
      return c.json({ error: { code: "relay_host_token_required", message: "Relay Host Token is required" } }, 401)
    }
    const body = await c.req.json().catch(() => undefined) as {
      sessionId?: unknown
      action?: unknown
      title?: unknown
    } | undefined
    if (
      typeof body?.sessionId !== "string"
      || !body.sessionId.trim()
      || !["read", "write", "register"].includes(String(body.action))
      || (body.title !== undefined && typeof body.title !== "string")
    ) {
      return c.json({ error: { code: "session_authority_request_invalid", message: "sessionId and a valid action are required" } }, 400)
    }
    const claims = await (options.verifyRelayProof ?? relayProofVerifier(options.env ?? process.env))(token).catch(() => undefined)
    if (!claims) {
      return c.json({ error: { code: "relay_host_token_invalid", message: "Relay Host Token is invalid or expired" } }, 401)
    }
    if (!claims.actor_id || !claims.actor_kind) {
      return c.json({ error: { code: "session_actor_required", message: "Verified actor claims are required" } }, 403)
    }
    try {
      const authority = requireAuthority(services)
      if (body.action === "register") {
        if (!authority.registerRuntimeSession) throw new Error("runtime session registration is unavailable")
        await authority.registerRuntimeSession({
          actorId: claims.actor_id,
          actorKind: claims.actor_kind,
          sessionId: body.sessionId,
          workspaceId: claims.workspace_id,
          ...(typeof body.title === "string" && body.title.trim() ? { title: body.title.trim() } : {}),
        })
        return c.json({ allowed: true })
      }
      if (!authority.authorizeRuntimeSession) throw new Error("runtime session authority is unavailable")
      await authority.authorizeRuntimeSession({
        actorId: claims.actor_id,
        actorKind: claims.actor_kind,
        sessionId: body.sessionId,
        workspaceId: claims.workspace_id,
        action: body.action as "read" | "write",
      })
      return c.json({ allowed: true })
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) {
        return c.json(controlPlaneAuthErrorBody(error), error.status as 401 | 403 | 503)
      }
      return c.json({ error: { code: "session_authority_denied", message: "Session access is denied" } }, 403)
    }
  })
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
