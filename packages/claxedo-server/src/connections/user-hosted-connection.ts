import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "../platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import { requireAuthority } from "../platform/auth/authority"
import { normalizeClaxedoRegion } from "../platform/runtime/region"
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

export async function userHostedConnectionInfo(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  workspaceId: string,
  previousJti?: string,
) {
  const authority = requireAuthority(services)
  await authority.usersMe(auth)
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

  const activeLink = await authority.activeLocalHostLink(auth, { workspaceId })
  if (!activeLink.active) {
    await authority.auditDeny(auth, {
      action: "runtime_access_token.denied",
      reason: "local_host_link_unavailable",
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
  const token = await signer({
    subject: auth.user.subject,
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
      expiresAt: token.tokenExpiresAt,
    }),
    authority.auditAllow(auth, {
      action: "runtime_access_token.minted",
      workspaceId,
      metadata: {
        jti: token.jti,
        hostId,
        expiresAt: token.tokenExpiresAt,
        localHostLinkExpiresAt: activeLink.expires_at,
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
      localHostLinkExpiresAt: activeLink.expires_at,
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
      workspaceId,
      homeRegion,
      relayUrl,
      runtimeAccessToken: token.runtimeAccessToken,
      tokenExpiresAt: token.tokenExpiresAt,
      role,
    },
  } as const
}
