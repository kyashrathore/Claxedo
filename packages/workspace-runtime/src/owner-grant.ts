import { createMiddleware } from "hono/factory"
import { jwtVerify, type JWTPayload } from "jose"
import { bearerToken } from "./routes/http"
import {
  loadWorkspaceRuntimeManagementVerificationKey,
  type LoadWorkspaceRuntimeManagementKeyEnv,
  type WorkspaceRuntimeManagementVerifierKey,
} from "./management-auth"
import { workspaceId as workspaceIdFromEnv } from "./target"
import type { EmbeddedRelayHostIdentity, RelayHostAuthContext } from "./workspace-host-service-auth"

export const WORKSPACE_RUNTIME_OWNER_GRANT_ISSUER = "claxedo-control-plane"
export const WORKSPACE_RUNTIME_OWNER_GRANT_AUDIENCE = "workspace-runtime-owner"

/**
 * The verified owner identity behind a bearer, or nothing.
 *
 * Nothing is the answer to every bearer that is not a live owner grant for
 * this workspace: an in-process caller that presents one it cannot verify
 * proceeds with no actor, exactly as one that presented none.
 */
export type OwnerGrantIdentity = (token: string) => Promise<EmbeddedRelayHostIdentity | undefined>

function claim(payload: JWTPayload, name: string) {
  const value = payload[name]
  return typeof value === "string" && value.trim() ? value : undefined
}

/**
 * How a runtime reads the owner grant the control plane launched it with.
 *
 * The runtime never chooses an actor: the grant names one workspace, the
 * control plane signed it with the key this runtime already trusts for its
 * management traffic, and the identity stamped from it is the workspace's
 * owner as the control plane recorded them at mint time. The control plane
 * re-resolves that owner on every authority call the identity leads to, so
 * the stamp is a claim the runtime forwards, not one it vouches for.
 */
export function ownerGrantIdentity(input: { key: WorkspaceRuntimeManagementVerifierKey; workspaceId: string }): OwnerGrantIdentity {
  return async (token) => {
    let payload: JWTPayload
    try {
      const options = { issuer: WORKSPACE_RUNTIME_OWNER_GRANT_ISSUER, audience: WORKSPACE_RUNTIME_OWNER_GRANT_AUDIENCE }
      payload = (typeof input.key === "function" ? await jwtVerify(token, input.key, options) : await jwtVerify(token, input.key, options)).payload
    } catch {
      return undefined
    }
    const actorId = claim(payload, "actor_id")
    const orgId = claim(payload, "org_id")
    const workspaceId = claim(payload, "workspace_id")
    if (!actorId || !orgId || workspaceId !== input.workspaceId) return undefined
    return {
      principal_kind: "user",
      actor_id: actorId,
      actor_kind: "human",
      actor_public_id: actorId,
      actor_name: "workspace owner",
      org_id: orgId,
      workspace_id: workspaceId,
      role: "owner",
    }
  }
}

/** The verifier over the management verification key, or nothing where no such key is configured. */
export async function ownerGrantIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<OwnerGrantIdentity | undefined> {
  const keys: LoadWorkspaceRuntimeManagementKeyEnv = {
    WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL: env.WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL?.trim() || undefined,
    WORKSPACE_RUNTIME_MANAGEMENT_VERIFY_PEM: env.WORKSPACE_RUNTIME_MANAGEMENT_VERIFY_PEM?.trim() || undefined,
  }
  if (!keys.WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL && !keys.WORKSPACE_RUNTIME_MANAGEMENT_VERIFY_PEM) return undefined
  return ownerGrantIdentity({
    key: await loadWorkspaceRuntimeManagementVerificationKey(keys),
    workspaceId: workspaceIdFromEnv(env),
  })
}

/** Stamps the owner behind an in-process request's bearer, when there is one this runtime can verify. */
export function createOwnerGrantInProcessMiddleware(identity: OwnerGrantIdentity) {
  return createMiddleware<{ Variables: RelayHostAuthContext }>(async (c, next) => {
    const token = bearerToken(c.req.header("authorization"))
    const owner = token ? await identity(token) : undefined
    if (owner) c.set("relayHostAuth", owner)
    await next()
  })
}
