import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { configuredRuntimeAccessTokenSigner, type WorkspaceRouteOptions } from "../workspace/route-support"

/** A Runtime Access Token for the one Durable Object that serves a session, reaching that session's routes alone. */
export async function mintSessionHostConnection(
  authority: WorkspaceAuthority,
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  input: { workspaceId: string; sessionId: string; orgId: string; relayUrl: string; role: "viewer" | "editor" },
) {
  const { workspaceId, sessionId, role } = input
  const hostId = sessionHostId(sessionId)
  const actor = await resolveRuntimeActor(authority, auth)
  const token = await configuredRuntimeAccessTokenSigner(options)({
    principalKind: "user", ...actor, orgId: input.orgId, workspaceId, hostId, role, sessionId,
  })
  await authority.recordRuntimeAccessToken(auth, {
    jti: token.jti, workspaceId, hostId, actorId: actor.actorId, actorKind: actor.actorKind, role, sessionId, expiresAt: token.tokenExpiresAt,
  })
  await authority.auditAllow(auth, {
    action: "runtime_access_token.minted",
    workspaceId,
    metadata: { jti: token.jti, hostId, expiresAt: token.tokenExpiresAt, backing: "durable-object", sessionId },
  })
  return {
    connection: {
      backing: "durable-object" as const,
      sessionAuthority: "managed-private" as const,
      workspaceId,
      hostId,
      sessionId,
      relayUrl: input.relayUrl,
      runtimeAccessToken: token.runtimeAccessToken,
      tokenExpiresAt: token.tokenExpiresAt,
      role,
    },
  }
}
