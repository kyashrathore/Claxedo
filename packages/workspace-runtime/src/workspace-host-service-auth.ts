import { createMiddleware } from "hono/factory"
import { createRemoteJWKSet, importSPKI } from "jose"
import type { RelayHostVerifierClaims, TokenVerifier } from "@claxedo/workspace-relay-protocol"
import {
  WorkspaceRelayAuthError,
  isRelayBacking,
  relayHostTokenAudience,
  relayHostTokenIssuer,
  verifyRelayHostToken,
  type RelayHostTokenClaims,
  type RelayKey,
} from "@claxedo/workspace-relay"
import { bearerToken, errorBody } from "./routes/http"
import { trimToUndefined } from "@claxedo/helpers/string"
import { numberClaim } from "@claxedo/helpers/guards"

export type RelayHostAuthOptions = {
  /**
   * A static public key or a JWKS resolver; `verifyRelayHostToken` takes
   * either, and jose dispatches by `kid` when given the resolver.
   */
  key: RelayKey
  workspaceId: string
  hostId: string
  trustedDirectTokenForRequest?: (input: {
    token: string
    path: string
    method: string
  }) => boolean | Promise<boolean>
  audit?: (event: RelayHostAuthAuditEvent) => void | Promise<void>
  /**
   * Supersedes `key` when set. The claims it vouches for are re-validated
   * against this workspace and host here, so a mismatch answers with the
   * same codes as the key path.
   */
  verifier?: TokenVerifier<RelayHostVerifierClaims>
}

export type RelayHostAuthContext = {
  relayHostAuth?: RelayHostTokenClaims | EmbeddedRelayHostIdentity
  relayHostDirectAuth?: true
}

/**
 * Verified actor identity stamped by the in-process local-server boundary.
 * Deliberately not a Relay Host Token: it has no signature lifecycle, issuer,
 * audience, or token identifiers to synthesize. `backing` is the placement the
 * control plane mints on a Relay Host Token, carried here verbatim when the
 * stamping boundary has it; nothing on this side derives it.
 */
export type EmbeddedRelayHostIdentity = {
  principal_kind: "user" | "service"
  actor_id: string
  actor_kind: "human" | "agent"
  actor_public_id: string
  actor_name: string
  actor_avatar_url?: string
  org_id: string
  workspace_id: string
  role: "viewer" | "editor" | "admin" | "owner"
  host_id?: string
  backing?: "cloud-vm" | "local-worktree"
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

function pem(input: string | undefined) {
  return trimToUndefined(input)?.replaceAll("\\n", "\n")
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
  const org_id = stringClaim(payload, "org_id")
  const workspace_id = stringClaim(payload, "workspace_id")
  const host_id = stringClaim(payload, "host_id")
  const role = roleClaim(payload)
  const actor_id = stringClaim(payload, "actor_id")
  const actor_kind = actorKindClaim(payload)
  const actor_public_id = stringClaim(payload, "actor_public_id")
  const actor_name = stringClaim(payload, "actor_name")
  const actor_avatar_url = stringClaim(payload, "actor_avatar_url")
  const backing = stringClaim(payload, "backing")
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
    || payload.access !== undefined
    || !isRelayBacking(backing)
    || !exp
    || !iat
    || !jti
    || !parent_jti
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
    backing,
    exp,
    iat,
    jti,
    parent_jti,
  } as const
  return claims
}

export type LoadRelayHostVerificationKeyEnv = {
  WORKSPACE_RUNTIME_RELAY_JWKS_URL?: string | undefined
  WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM?: string | undefined
}

/**
 * `WORKSPACE_RUNTIME_RELAY_JWKS_URL` wins over
 * `WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM`: a remote key set lets the relay
 * rotate its signing key without a host restart, a PEM is one Ed25519 key
 * for the process's life.
 *
 * Throws when neither is set. A host that accepts any token, or refuses
 * every one silently, is worse than one that will not boot.
 */
export async function loadRelayHostVerificationKeyOrJwks(
  env: LoadRelayHostVerificationKeyEnv,
): Promise<RelayKey> {
  const jwksUrl = trimToUndefined(env.WORKSPACE_RUNTIME_RELAY_JWKS_URL)
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

/**
 * Verify one Relay Host Token outside a middleware.
 *
 * The middleware above is the relay exposure's gate: it owns the response and
 * the `x-workspace-id`/`x-forwarded-by` checks the exposure needs. A host that
 * serves its runtimes IN PROCESS has no such gate — it stamps a verified actor
 * onto an in-process hop instead — and needs the same verification as a plain
 * question. Nothing is the answer to every token this key set does not
 * validate for this workspace and host; a caller that reads nothing as
 * "unverified" and refuses is the whole point.
 *
 * The JWKS address is read per call because a machine is told it by a
 * heartbeat ack, after its runtimes exist. One `createRemoteJWKSet` per
 * address is kept: jose caches the fetched key set on the resolver, so
 * rebuilding it per request would refetch the relay's keys on every request.
 */
export type RelayHostTokenVerifier = (input: {
  token: string
  workspaceId: string
  hostId: string
}) => Promise<RelayHostTokenClaims | undefined>

export function createRelayHostTokenVerifier(jwksUrl: () => string | undefined): RelayHostTokenVerifier {
  const keys = new Map<string, RelayKey>()
  return async ({ token, workspaceId, hostId }) => {
    const url = jwksUrl()?.trim()
    if (!url) return undefined
    let key = keys.get(url)
    if (!key) {
      key = createRemoteJWKSet(new URL(url))
      keys.set(url, key)
    }
    try {
      return await verifyRelayHostToken(token, key, { workspaceId, hostId })
    } catch {
      return undefined
    }
  }
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
      && await options.trustedDirectTokenForRequest?.({
        token,
        path: c.req.path,
        method: c.req.method,
      })
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
      // Every token the verifier accepts carries a `backing`, so this covers
      // all of them: the relay stamps `x-forwarded-by` on each request it
      // forwards, and a valid token arriving without it was replayed around
      // the relay. The control plane's own token took the direct branch above.
      if (claims.backing) {
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
