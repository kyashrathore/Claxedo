import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import { normalizeClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import {
  apiError,
  captureWorkspaceTelemetry,
  configuredRelayUrl,
  configuredRuntimeAccessTokenSigner,
  relayRole,
  type WorkspaceRouteOptions,
} from "../workspace/route-support"
import {
  previousRuntimeAccessTokenError,
  runtimeTokenOrgId,
  workspaceOpenAuthorizationError,
} from "../workspace/runtime-token-guards"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"

export async function userHostedConnectionInfo(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  workspaceId: string,
  previousJti?: string,
) {
  const authority = requireAuthority(services)
  const result = await authority.openWorkspace(auth, { workspaceId })
  const authz = await workspaceOpenAuthorizationError(services, auth, result, workspaceId)
  if (authz) return authz
  if (
    result.workspace?.backing !== "local-worktree"
    || result.workspace.access !== "user-hosted"
  ) {
    return {
      error: apiError("workspace_relay_user_hosted_required", "Workspace Relay user-hosted connection is only available for shared local workspaces"),
      status: 400,
    } as const
  }

  const activeLink = await authority.activeWorkspaceHost(auth, { workspaceId })
  if (!activeLink.active) {
    await authority.auditDeny(auth, {
      action: "runtime_access_token.denied",
      reason: "workspace_host_unavailable",
      workspaceId,
    })
    return {
      error: apiError("user_hosted_workspace_unavailable", "User-hosted sandbox is unavailable"),
      status: 409,
    } as const
  }

  const hostId = activeLink.host_id
  const role = relayRole(result.role)
  const homeRegion = normalizeClaxedoRegion(result.workspace.home_region, options.defaultHomeRegion)
  const relayUrl = configuredRelayUrl(options, homeRegion)
  if (!relayUrl) {
    throw new ControlPlaneAuthError(
      503,
      "runtime_access_token_signer_unavailable",
      "Workspace Relay URL is not configured",
    )
  }
  captureWorkspaceTelemetry({
    services,
    auth,
    event: "workspace.connection.requested",
    workspaceId,
    properties: {
      access: "user-hosted",
      backing: "local-worktree",
      runtimeKind: "user-hosted",
      homeRegion,
      relayRoom: workspaceId,
      hostId,
    },
  })

  const previousToken = await previousRuntimeAccessTokenError(services, auth, {
    previousJti,
    workspaceId,
    hostId,
  })
  if (previousToken) return previousToken

  const signer = configuredRuntimeAccessTokenSigner(options)
  const orgId = await runtimeTokenOrgId(authority, auth, result.workspace)
  const actor = await resolveRuntimeActor(authority, auth)
  const token = await signer({
    principalKind: "user",
    ...actor,
    orgId,
    workspaceId,
    hostId,
    role,
  })
  await Promise.all([
    authority.recordRuntimeAccessToken(auth, {
      jti: token.jti,
      workspaceId,
      hostId,
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      role,
      expiresAt: token.tokenExpiresAt,
    }),
    authority.auditAllow(auth, {
      action: "runtime_access_token.minted",
      workspaceId,
      metadata: {
        jti: token.jti,
        hostId,
        expiresAt: token.tokenExpiresAt,
        hostLeaseExpiresAt: activeLink.expires_at,
      },
    }),
  ])
  captureWorkspaceTelemetry({
    services,
    auth,
    event: "runtime_access_token.minted",
    workspaceId,
    properties: {
      access: "user-hosted",
      backing: "local-worktree",
      hostId,
      role,
      jti: token.jti,
      expiresAt: token.tokenExpiresAt,
      hostLeaseExpiresAt: activeLink.expires_at,
      relayRoom: workspaceId,
      relayUrl,
    },
  })
  if (previousJti) {
    await authority.revokeRuntimeAccessToken(auth, { jti: previousJti, workspaceId })
  }
  return {
    connection: {
      access: "user-hosted" as const,
      backing: "local-worktree" as const,
      runtimeKind: "user-hosted" as const,
      // Which stream scopes the runtime behind this connection serves, in the
      // HOST's own words: the machine that serves this workspace declares its
      // runtime's `SessionAccessPolicy.sessionAuthority` on every heartbeat,
      // and `activeWorkspaceHost` hands back what it declared.
      //
      // The control plane does not decide this and cannot derive it. A
      // user-hosted workspace runs on the owner's machine, and that machine
      // composes either flavour: an unsigned desktop daemon leaves its
      // embedded runtime on `managedWorkspaceSessionAccessPolicy()` with no
      // injected authority (`"local"`, serving the workspace-wide streams),
      // while a signed self-hosted host injects one
      // (`embeddedManagedPrivateSessionPolicy`, `"managed-private"`, which
      // answers an unscoped `/api/wr/events` with a permanent 400
      // `session_event_scope_required`).
      //
      // A host that declared nothing yields no scope at all. The client then
      // opens no workspace stream and says why, which is the honest outcome:
      // either guess is wrong for one of the two compositions, and guessing
      // "local" at a managed-private host costs more than silence — the
      // refused stream drives `[claxedo-events]` through its whole retry
      // ladder, the workspace goes unhealthy, and the pane is torn down.
      ...(activeLink.session_authority ? { sessionAuthority: activeLink.session_authority } : {}),
      workspaceId,
      homeRegion,
      relayUrl,
      runtimeAccessToken: token.runtimeAccessToken,
      tokenExpiresAt: token.tokenExpiresAt,
      role,
    },
  } as const
}
