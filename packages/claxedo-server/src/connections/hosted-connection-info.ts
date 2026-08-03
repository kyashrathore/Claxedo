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
import { userHostedConnectionInfo } from "./user-hosted-connection"
import {
  previousRuntimeAccessTokenError,
  runtimeTokenOrgId,
  workspaceOpenAuthorizationError,
} from "../workspace/runtime-token-guards"

export async function hostedConnectionInfo(
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
    result.workspace?.backing === "local-worktree"
    && result.workspace.access === "user-hosted"
  ) {
    return userHostedConnectionInfo(services, options, auth, workspaceId, previousJti)
  }
  if (
    result.workspace?.backing !== "cloud-vm"
    || result.workspace.access !== "cloud"
  ) {
    return {
      error: apiError("workspace_relay_unsupported", "Workspace connection is only available for user-hosted or cloud workspaces"),
      status: 400,
    } as const
  }
  // Adversarial review: enforce the cloud-workspace entitlement at
  // wake/resume, not only at create — otherwise a canceled subscription leaves
  // existing cloud workspaces wake-able forever. Reached ONLY for HOSTED cloud
  // workspaces (backing=cloud-vm / access=cloud, asserted above); the hook is
  // composed exclusively in hosted-app.ts, so self-host / local never gate.
  // Denied → the typed billing_entitlement_required (402) the frontend acts on,
  // BEFORE any sandbox wake side effect.
  if (options.requireCloudWorkspaceEntitlement) {
    const denied = await options.requireCloudWorkspaceEntitlement(auth)
    if (denied) {
      const body = denied.body as { error?: { code: string; message: string } } | undefined
      return {
        error:
          body?.error ??
          apiError("billing_entitlement_required", "An active Claxedo Cloud subscription is required"),
        status: denied.status,
      } as const
    }
  }
  const hostManager = services?.sandbox.sandboxManager
  if (!hostManager) {
    return {
      error: apiError("sandbox_unavailable", "Cloud sandbox is not configured"),
      status: 503,
    } as const
  }

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
      access: "cloud",
      backing: "cloud-vm",
      runtimeKind: "cloud",
      homeRegion,
      relayRoom: workspaceId,
    },
  })

  const ensured = await hostManager.ensure(workspaceId, { homeRegion })
  captureWorkspaceTelemetry({
    services,
    auth,
    event: "sandbox.ensure",
    workspaceId,
    properties: {
      status: ensured.status,
      homeRegion,
      relayRoom: workspaceId,
      ...(ensured.status === "provisioning" ? { leaseEpoch: ensured.epoch, retryAfterMs: ensured.retryAfterMs } : {}),
      ...(ensured.status === "unavailable" ? { retryAfterMs: ensured.retryAfterMs } : {}),
      ...(ensured.status === "ready" ? {
        hostId: ensured.hostId,
        leaseEpoch: ensured.epoch,
        ...(ensured.driverResourceId ? { driverResourceId: ensured.driverResourceId } : {}),
      } : {}),
    },
  })
  if (ensured.status === "provisioning") {
    return {
      connection: {
        status: "provisioning" as const,
        workspaceId,
        runtimeKind: "cloud" as const,
        homeRegion,
        retryAfterMs: ensured.retryAfterMs,
        // Which boot path this cycle is on (restore | resume | cold-start),
        // when the manager knows it — the connect UI renders it instead of a
        // generic "preparing" spinner. Absent while the lease is still queued
        // behind a retry window or another caller.
        ...(ensured.bootMode ? { bootMode: ensured.bootMode } : {}),
      },
    } as const
  }
  if (ensured.status === "unavailable") {
    captureWorkspaceTelemetry({
      services,
      auth,
      event: "workspace.connection.unavailable",
      workspaceId,
      properties: {
        runtimeKind: "cloud",
        homeRegion,
        relayRoom: workspaceId,
        retryAfterMs: ensured.retryAfterMs,
      },
    })
    return {
      error: apiError("cloud_runtime_unavailable", "Cloud runtime is unavailable", {
        retryAfterMs: ensured.retryAfterMs,
      }),
      status: 409,
    } as const
  }

  const previousToken = await previousRuntimeAccessTokenError(services, auth, {
    previousJti,
    workspaceId,
    hostId: ensured.hostId,
  })
  if (previousToken) return previousToken

  const role = relayRole(result.role)
  const signer = configuredRuntimeAccessTokenSigner(options)
  const orgId = await runtimeTokenOrgId(authority, auth, result.workspace)
  const token = await signer({
    subject: auth.user.subject,
    orgId,
    workspaceId,
    hostId: ensured.hostId,
    role,
  })
  await authority.recordRuntimeAccessToken(auth, {
    jti: token.jti,
    workspaceId,
    hostId: ensured.hostId,
    expiresAt: token.tokenExpiresAt,
  })
  await authority.auditAllow(auth, {
    action: "runtime_access_token.minted",
    workspaceId,
    metadata: {
      jti: token.jti,
      hostId: ensured.hostId,
      expiresAt: token.tokenExpiresAt,
      runtimeKind: "cloud",
      homeRegion,
      leaseEpoch: ensured.epoch,
      ...(ensured.driverResourceId ? { driverResourceId: ensured.driverResourceId } : {}),
      relayRoom: workspaceId,
      relayUrl,
    },
  })
  captureWorkspaceTelemetry({
    services,
    auth,
    event: "runtime_access_token.minted",
    workspaceId,
    properties: {
      access: "cloud",
      backing: "cloud-vm",
      hostId: ensured.hostId,
      role,
      jti: token.jti,
      expiresAt: token.tokenExpiresAt,
      homeRegion,
      leaseEpoch: ensured.epoch,
      ...(ensured.driverResourceId ? { driverResourceId: ensured.driverResourceId } : {}),
      relayRoom: workspaceId,
      relayUrl,
    },
  })
  if (previousJti) {
    await authority.revokeRuntimeAccessToken(auth, { jti: previousJti, workspaceId })
  }
  return {
    connection: {
      access: "cloud" as const,
      backing: "cloud-vm" as const,
      runtimeKind: "cloud" as const,
      workspaceId,
      homeRegion,
      relayUrl,
      runtimeAccessToken: token.runtimeAccessToken,
      tokenExpiresAt: token.tokenExpiresAt,
      role,
      hostId: ensured.hostId,
    },
  } as const
}
