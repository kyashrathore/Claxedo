import { createMiddleware } from "hono/factory"
import { createRemoteJWKSet, importSPKI } from "jose"
import type { RelayHostVerifierClaims, TokenVerifier } from "@claxedo/workspace-relay-protocol"
import {
  WorkspaceRelayAuthError,
  isRelayClaimPair,
  relayHostTokenAudience,
  relayHostTokenIssuer,
  verifyRelayHostToken,
  type RelayHostTokenClaims,
  type RelayKey,
} from "@claxedo/workspace-relay"
import { bearerToken, errorBody } from "./routes/http"

export type RelayHostAuthOptions = {
  /**
   * Either a single static public key (PEM env-var fallback path) or a
   * JWKS resolver function (the new JWKS-aware path produced by
   * `loadRelayHostVerificationKeyOrJwks`). `verifyRelayHostToken` accepts
   * both via the `RelayKey` union — when a function is passed, jose
   * dispatches to JWKS-by-`kid`.
   */
  key: RelayKey
  workspaceId: string
  hostId: string
  trustedDirectToken?: string
  trustedDirectTokenForRequest?: (input: {
    token: string
    path: string
    method: string
  }) => boolean | Promise<boolean>
  audit?: (event: RelayHostAuthAuditEvent) => void | Promise<void>
  /**
   * P-shared.2: optional override for Relay Host Token verification.
   *
   * When set, supersedes `key` and routes verification through the
   * unified `TokenVerifier` interface from
   * `@claxedo/workspace-relay-protocol`. The verifier returns
   * `{ scopes, claims }`; we hydrate the existing
   * `RelayHostTokenClaims` shape from `claims` so workspace/host
   * mismatches keep their original error semantics.
   *
   * Use a `StaticTokenVerifier` for tests; an `HttpTokenVerifier` for
   * remote introspection; or a custom impl for hosted-control-plane
   * deployments.
   */
  verifier?: TokenVerifier<RelayHostVerifierClaims>
}

export type RelayHostAuthContext = {
  relayHostAuth?: RelayHostTokenClaims
  relayHostDirectAuth?: true
}

export type RelayHostAuthAuditEvent = {
  action: "relay_host_token.accepted" | "relay_host_token.rejected" | "direct_host_token.accepted"
  result: "allow" | "deny"
  reason?: string
  workspaceId: string
  hostId: string
  path: string
  method: string
}

function clean(input: string | undefined) {
  const value = input?.trim()
  return value ? value : undefined
}

function pem(input: string | undefined) {
  return clean(input)?.replaceAll("\\n", "\n")
}

function stringClaim(payload: Record<string, unknown>, key: string) {
  const value = payload[key]
  return typeof value === "string" && value.trim() ? value : undefined
}

function roleClaim(payload: Record<string, unknown>) {
  const value = stringClaim(payload, "role")
  return value === "viewer" || value === "editor" || value === "admin" || value === "owner" ? value : undefined
}

function actorKindClaim(payload: Record<string, unknown>) {
  const value = stringClaim(payload, "actor_kind")
  return value === "human" || value === "agent" ? value : undefined
}

function numberClaim(payload: Record<string, unknown>, key: string) {
  const value = payload[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function validateRelayHostVerifierClaims(
  payload: Record<string, unknown>,
  expected: { workspaceId: string; hostId: string },
): RelayHostTokenClaims {
  if (stringClaim(payload, "iss") !== relayHostTokenIssuer) {
    throw new WorkspaceRelayAuthError("relay_token_claims_invalid", "Relay Host Token issuer is invalid")
  }
  if (stringClaim(payload, "aud") !== relayHostTokenAudience) {
    throw new WorkspaceRelayAuthError("relay_token_claims_invalid", "Relay Host Token audience is invalid")
  }

  const principal_kind = stringClaim(payload, "principal_kind")
  const actor_id = stringClaim(payload, "actor_id")
  const actor_kind = stringClaim(payload, "actor_kind")
  const actor_public_id = stringClaim(payload, "actor_public_id")
  const actor_name = stringClaim(payload, "actor_name")
  const actor_avatar_url = stringClaim(payload, "actor_avatar_url")
  const org_id = stringClaim(payload, "org_id")
  const workspace_id = stringClaim(payload, "workspace_id")
  const host_id = stringClaim(payload, "host_id")
  const role = roleClaim(payload)
  const actor_id = stringClaim(payload, "actor_id")
  const actor_kind = actorKindClaim(payload)
  const actor_public_id = stringClaim(payload, "actor_public_id")
  const actor_name = stringClaim(payload, "actor_name")
  const actor_avatar_url = stringClaim(payload, "actor_avatar_url")
  const access = stringClaim(payload, "access")
  const backing = stringClaim(payload, "backing")
  const pair = { access, backing }
  const exp = numberClaim(payload, "exp")
  const iat = numberClaim(payload, "iat")
  const jti = stringClaim(payload, "jti")
  const parent_jti = stringClaim(payload, "parent_jti")

  if (
    !actor_id
    || (principal_kind !== "user" && principal_kind !== "service")
    || (actor_kind !== "human" && actor_kind !== "agent")
    || (principal_kind === "user" && actor_kind !== "human")
    || (principal_kind === "service" && actor_kind !== "agent")
    || !org_id
    || !workspace_id
    || !host_id
    || !role
    || !isRelayClaimPair(pair)
    || !exp
    || !iat
    || !jti
    || (!!actor_id !== !!actor_kind)
    || (!!actor_public_id !== !!actor_name)
    || (!!actor_avatar_url && (!actor_public_id || !actor_name))
  ) {
    throw new WorkspaceRelayAuthError("relay_token_claims_invalid", "Relay Host Token claims are incomplete")
  }
  if (workspace_id !== expected.workspaceId) {
    throw new WorkspaceRelayAuthError("relay_token_workspace_mismatch", "Relay token workspace does not match request")
  }
  if (host_id !== expected.hostId) {
    throw new WorkspaceRelayAuthError("relay_token_host_mismatch", "Relay token host does not match request")
  }

  const claims = {
    iss: relayHostTokenIssuer,
    aud: relayHostTokenAudience,
    principal_kind,
    actor_id,
    actor_kind,
    ...(actor_public_id && actor_name
      ? { actor_public_id, actor_name, ...(actor_avatar_url ? { actor_avatar_url } : {}) }
      : {}),
    org_id,
    workspace_id,
    host_id,
    role,
    ...pair,
    exp,
    iat,
    jti,
  } as const
  if (actor_id && actor_kind) return {
    ...claims,
    actor_id,
    actor_kind,
    ...(actor_public_id && actor_name
      ? { actor_public_id, actor_name, ...(actor_avatar_url ? { actor_avatar_url } : {}) }
      : {}),
  }
  return { ...claims, actor_id: undefined, actor_kind: undefined }
}

/**
 * Resolve the verification key (or JWKS resolver) for Relay Host Tokens.
 *
 * Precedence:
 *   1. `WORKSPACE_RUNTIME_RELAY_JWKS_URL` — resolved via
 *      `jose.createRemoteJWKSet`, allowing the relay's host-token signing key to
 *      rotate without restarting the workspace host.
 *   2. `WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM` —
 *      a single static SPKI PEM, imported as an Ed25519 public key.
 *
 * Fails closed when neither is set: there is no acceptable default — a
 * mis-configured workspace host that accepts any token (or refuses all of
 * them silently) is worse than refusing to boot.
 *
 * Exported for tests.
 */
export type LoadRelayHostVerificationKeyEnv = {
  WORKSPACE_RUNTIME_RELAY_JWKS_URL?: string | undefined
  WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM?: string | undefined
}

export async function loadRelayHostVerificationKeyOrJwks(
  env: LoadRelayHostVerificationKeyEnv,
): Promise<RelayKey> {
  const jwksUrl = clean(env.WORKSPACE_RUNTIME_RELAY_JWKS_URL)
  if (jwksUrl) {
    return createRemoteJWKSet(new URL(jwksUrl))
  }
  const verifyPem = pem(env.WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM)
  if (!verifyPem) {
    throw new Error(
      "Relay Host Token verification key is not configured: set WORKSPACE_RUNTIME_RELAY_JWKS_URL or WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM",
    )
  }
  return importSPKI(verifyPem, "EdDSA")
}

async function audit(options: RelayHostAuthOptions, input: Omit<RelayHostAuthAuditEvent, "workspaceId" | "hostId">) {
  await options.audit?.({
    ...input,
    workspaceId: options.workspaceId,
    hostId: options.hostId,
  })
}

// This middleware verifies the RHT at request establishment. Long-lived
// session-derived event streams separately re-authorize each event through the
// session access policy, which also expires stale proofs and observes
// participant revocation. Other upgraded connections remain trusted until
// close and require a fresh RHT when they reconnect.
export function createRelayHostAuthMiddleware(options: RelayHostAuthOptions) {
  return createMiddleware<{ Variables: RelayHostAuthContext }>(async (c, next) => {
    const token = bearerToken(c.req.header("authorization"))
    if (
      token
      && (
        (options.trustedDirectToken && token === options.trustedDirectToken)
        || await options.trustedDirectTokenForRequest?.({
          token,
          path: c.req.path,
          method: c.req.method,
        })
      )
    ) {
      await audit(options, {
        action: "direct_host_token.accepted",
        result: "allow",
        path: c.req.path,
        method: c.req.method,
      })
      c.set("relayHostDirectAuth", true)
      return await next()
    }

    if (!token) {
      await audit(options, {
        action: "relay_host_token.rejected",
        result: "deny",
        reason: "relay_host_token_required",
        path: c.req.path,
        method: c.req.method,
      })
      return c.json(errorBody("relay_host_token_required", "Relay Host Token is required"), 401)
    }

    try {
      // P-shared.2: prefer injected `verifier` when configured; fall
      // back to the legacy `key`-based JWT path otherwise.
      const claims = options.verifier
        ? validateRelayHostVerifierClaims((await options.verifier.verify(token)).claims, {
            workspaceId: options.workspaceId,
            hostId: options.hostId,
          })
        : await verifyRelayHostToken(token, options.key, {
            workspaceId: options.workspaceId,
            hostId: options.hostId,
          })
      if (!c.req.header("x-workspace-id")) {
        await audit(options, {
          action: "relay_host_token.rejected",
          result: "deny",
          reason: "relay_workspace_required",
          path: c.req.path,
          method: c.req.method,
        })
        return c.json(errorBody(
          "relay_workspace_required",
          "Relay request workspace header is required",
        ), 400)
      }
      if (c.req.header("x-workspace-id") !== options.workspaceId) {
        await audit(options, {
          action: "relay_host_token.rejected",
          result: "deny",
          reason: "relay_workspace_unknown",
          path: c.req.path,
          method: c.req.method,
        })
        return c.json(errorBody(
          "relay_workspace_unknown",
          "Relay request workspace is not hosted by this Workspace Host Service",
        ), 404)
      }
      // T27: For RHTs whose `access` is "cloud" or "user-hosted", the only
      // legitimate caller is the workspace-relay (T13 sets the marker on
      // every forwarded request). The `access: "local"` paths bypass the
      // relay entirely and arrive via `proxy.ts` direct-token, which takes
      // the `trustedDirectToken` branch above and never reaches this point.
      if (claims.access === "cloud" || claims.access === "user-hosted") {
        if (c.req.header("x-forwarded-by") !== "workspace-relay") {
          await audit(options, {
            action: "relay_host_token.rejected",
            result: "deny",
            reason: "relay_marker_required",
            path: c.req.path,
            method: c.req.method,
          })
          return c.json(errorBody(
            "relay_marker_required",
            "Relay-forwarded marker is required for relay-issued tokens",
          ), 401)
        }
      }
      c.set("relayHostAuth", claims)
      await audit(options, {
        action: "relay_host_token.accepted",
        result: "allow",
        path: c.req.path,
        method: c.req.method,
      })
      return await next()
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err && typeof err.code === "string"
        ? err.code
        : "invalid_relay_host_token"
      await audit(options, {
        action: "relay_host_token.rejected",
        result: "deny",
        reason: code,
        path: c.req.path,
        method: c.req.method,
      })
      return c.json(errorBody(code, "Relay Host Token is invalid"), code.includes("mismatch") ? 403 : 401)
    }
  })
}
