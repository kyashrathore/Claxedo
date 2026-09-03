import { ControlPlaneAuthError, localControlPlaneAuth, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import { requireAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import type { SandboxEnsureResult } from "@claxedo/sandbox-manager"
import { resolveWorkspace, type Workspace } from "@claxedo/server-core/workspace/store/index"
import { apiError, captureWorkspaceTelemetry, configuredRelayUrl, configuredRuntimeAccessTokenSigner, relayRole, type WorkspaceRouteOptions } from "../workspace/route-support"
import { previousRuntimeAccessTokenError, workspaceOpenAuthorizationError } from "../workspace/runtime-token-guards"
import { CONTROL_PLANE_RUNTIME_ACTOR, resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
export async function cloudConnectionInfo(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  ws: Workspace,
  previousJti?: string,
) {
  if (ws.kind !== "cloud") {
    return {
      error: apiError(
        "workspace_relay_cloud_required",
        "Workspace Relay connection is only available for cloud workspaces",
      ),
      status: 400,
    } as const
  }
  const authority = requireAuthority(services)
  const result = await authority.openWorkspace(auth, { workspaceId: ws.id })
  const authz = await workspaceOpenAuthorizationError(services, auth, result, ws.id)
  if (authz) return authz
  const current = (await resolveWorkspace({ workspaceId: ws.id })) ?? ws
  const target = await ensureCloudRuntimeTarget(
    services,
    current,
    options.defaultHomeRegion ?? services?.defaultHomeRegion ?? "us-east",
  )
  if (target.status === "provisioning") {
    return {
      connection: {
        status: "provisioning" as const,
        workspaceId: ws.id,
        runtimeKind: "cloud" as const,
        retryAfterMs: target.retryAfterMs,
      },
    } as const
  }
  if (target.status === "unavailable") {
    return {
      error: apiError("cloud_runtime_unavailable", "Cloud runtime is unavailable", {
        retryAfterMs: target.retryAfterMs,
      }),
      status: 409,
    } as const
  }
  const hostId = target.hostId
  const role = relayRole(result.role)
  const actor = await resolveRuntimeActor(authority, auth)
  const relayUrl = configuredRelayUrl(options)
  if (!relayUrl) {
    throw new ControlPlaneAuthError(
      503,
      "runtime_access_token_signer_unavailable",
      "Workspace Relay URL is not configured",
    )
  }
  const previousToken = await previousRuntimeAccessTokenError(services, auth, {
    previousJti,
    workspaceId: ws.id,
    hostId,
  })
  if (previousToken) return previousToken
  const orgId = await authority.resolveOrgId(auth)
  const token = await configuredRuntimeAccessTokenSigner(options)({
    principalKind: "user",
    ...actor,
    orgId,
    workspaceId: ws.id,
    hostId,
    role,
  })
  await authority.recordRuntimeAccessToken(auth, {
    jti: token.jti,
    workspaceId: ws.id,
    hostId,
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    role,
    expiresAt: token.tokenExpiresAt,
  })
  await authority.auditAllow(auth, {
    action: "runtime_access_token.minted",
    workspaceId: ws.id,
    metadata: {
      jti: token.jti,
      hostId,
      expiresAt: token.tokenExpiresAt,
    },
  })
  captureWorkspaceTelemetry({
    services,
    auth,
    event: "runtime_access_token.minted",
    workspaceId: ws.id,
    properties: {
      access: "cloud",
      backing: "cloud-vm",
      hostId,
      role,
      jti: token.jti,
      expiresAt: token.tokenExpiresAt,
    },
  })
  if (previousJti) {
    await authority.revokeRuntimeAccessToken(auth, {
      jti: previousJti,
      workspaceId: ws.id,
    })
  }
  return {
    connection: {
      access: "cloud",
      backing: "cloud-vm",
      // A provisioned sandbox is a non-loopback workspace-runtime exposure, so
      // `createWorkspaceRuntimeApp` composes `remoteWorkspaceSessionAccessPolicyFromEnv()`
      // and reports `sessionAuthority: "managed-private"`: its event streams
      // exist per session and an unscoped one answers 400
      // `session_event_scope_required`.
      sessionAuthority: "managed-private",
      workspaceId: ws.id,
      hostId,
      relayUrl,
      runtimeAccessToken: token.runtimeAccessToken,
      tokenExpiresAt: token.tokenExpiresAt,
      role,
    },
  } as const
}

async function ensureCloudRuntimeTarget(
  services: ControlPlaneServices | undefined,
  ws: Workspace,
  homeRegion: ClaxedoRegion,
): Promise<SandboxEnsureResult> {
  const sandboxManager = services?.sandbox.sandboxManager
  if (!sandboxManager) {
    return {
      status: "unavailable",
      error: `sandbox manager unavailable: ${ws.id}`,
      homeRegion,
    }
  }
  return sandboxManager.ensure(ws.id, {
    homeRegion,
  })
}

export async function localLoopbackCloudConnectionInfo(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  request: Request,
  ws: Workspace,
) {
  if (ws.kind !== "cloud") {
    return {
      error: apiError(
        "workspace_relay_cloud_required",
        "Workspace Relay connection is only available for cloud workspaces",
      ),
      status: 400,
    } as const
  }
  const current = (await resolveWorkspace({ workspaceId: ws.id })) ?? ws
  const target = await ensureCloudRuntimeTarget(
    services,
    current,
    options.defaultHomeRegion ?? services?.defaultHomeRegion ?? "us-east",
  )
  if (target.status === "provisioning") {
    return {
      connection: {
        status: "provisioning" as const,
        workspaceId: ws.id,
        runtimeKind: "cloud" as const,
        retryAfterMs: target.retryAfterMs,
      },
    } as const
  }
  if (target.status === "unavailable") {
    return {
      error: apiError("cloud_runtime_unavailable", "Cloud runtime is unavailable", {
        retryAfterMs: target.retryAfterMs,
      }),
      status: 409,
    } as const
  }
  const hostId = target.hostId
  const orgId = current.org_id ?? ws.org_id
  const token = options.runtimeAccessTokenSigner && orgId
    ? await options.runtimeAccessTokenSigner({
        ...CONTROL_PLANE_RUNTIME_ACTOR,
        orgId,
        workspaceId: ws.id,
        hostId,
        role: "owner",
      })
    : {
        runtimeAccessToken: `local-loopback-${ws.id}`,
        tokenExpiresAt: Date.now() + 24 * 60 * 60_000,
      }
  return {
    connection: {
      access: "cloud",
      backing: "cloud-vm",
      // This branch answers a LOOPBACK caller of the local server, whose
      // workspace runtimes are the embedded ones it starts itself
      // (`configureEmbeddedWorkspaceRuntime`) — an embedded exposure, so the
      // unbound local policy, so workspace-wide streams.
      sessionAuthority: "local",
      workspaceId: ws.id,
      hostId,
      relayUrl: localLoopbackRelayUrl(request, options),
      runtimeAccessToken: token.runtimeAccessToken,
      tokenExpiresAt: token.tokenExpiresAt,
      role: "owner",
    },
  } as const
}

function localLoopbackRelayUrl(request: Request, options: WorkspaceRouteOptions) {
  return configuredRelayUrl(options) ?? new URL(request.url).origin
}
