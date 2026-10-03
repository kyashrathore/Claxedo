import { sessionHostId } from "@claxedo/workspace-relay-protocol"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { configuredRuntimeAccessTokenSigner, type WorkspaceRouteOptions } from "../workspace/route-support"

/**
 * A Runtime Access Token for the one Durable Object that serves a session,
 * reached through the relay as host `session-do:<root>`. With `sessionId` it
 * reaches that session's routes alone; without it, minted only for the
 * workspace's owner creating the session, it also reaches the host's create
 * route, and the host id still confines it to that one object.
 */
export async function mintSessionHostConnection(
  authority: WorkspaceAuthority,
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  input: { workspaceId: string; root: string; orgId: string; relayUrl: string; role: "viewer" | "editor"; sessionId?: string },
) {
  const hostId = sessionHostId(input.root)
  const actor = await resolveRuntimeActor(authority, auth)
  const scope = input.sessionId === undefined ? {} : { sessionId: input.sessionId }
  const token = await configuredRuntimeAccessTokenSigner(options)({
    principalKind: "user",
    ...actor,
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    hostId,
    role: input.role,
    ...scope,
  })
  await authority.recordRuntimeAccessToken(auth, {
    jti: token.jti,
    workspaceId: input.workspaceId,
    hostId,
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    role: input.role,
    ...scope,
    expiresAt: token.tokenExpiresAt,
  })
  await authority.auditAllow(auth, {
    action: "runtime_access_token.minted",
    workspaceId: input.workspaceId,
    metadata: { jti: token.jti, hostId, expiresAt: token.tokenExpiresAt, backing: "durable-object", ...scope },
  })
  return {
    connection: {
      backing: "durable-object" as const,
      sessionAuthority: "managed-private" as const,
      workspaceId: input.workspaceId,
      hostId,
      sessionId: input.sessionId ?? input.root,
      relayUrl: input.relayUrl,
      runtimeAccessToken: token.runtimeAccessToken,
      tokenExpiresAt: token.tokenExpiresAt,
      role: input.role,
    },
  }
}
