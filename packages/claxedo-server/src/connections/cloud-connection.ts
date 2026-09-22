import type { ContentfulStatusCode } from "hono/utils/http-status"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import { requireAuthority, type WorkspaceAuthority, type WorkspaceOpenResult } from "@claxedo/server-core/platform/auth/authority"
import type { ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import type { SandboxEnsureResult } from "@claxedo/sandbox-manager"
import { resolveWorkspace, type Workspace } from "@claxedo/server-core/workspace/store/index"
import { apiError, captureWorkspaceTelemetry, configuredRelayUrl, configuredRuntimeAccessTokenSigner, relayRole, type WorkspaceRouteOptions } from "../workspace/route-support"
import { previousRuntimeAccessTokenError, workspaceOpenAuthorizationError } from "../workspace/runtime-token-guards"
import { CONTROL_PLANE_RUNTIME_ACTOR, resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"

type CloudWorkspaceGate =
  | { error: ReturnType<typeof apiError>; status: ContentfulStatusCode }
  | { authority: WorkspaceAuthority; result: WorkspaceOpenResult }

async function cloudWorkspaceGate(
  services: ControlPlaneServices | undefined,
  auth: SignedControlPlaneAuth,
  ws: Workspace,
): Promise<CloudWorkspaceGate> {
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
  return { authority, result }
}

/**
 * The mint tail the signed connect and read paths share once a ready sandbox
 * target exists. Minting itself never provisions; it only ever runs after the
 * caller's own `ensure`/`target` resolved a ready lease.
 */
async function mintSignedCloudConnection(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  ws: Workspace,
  context: { authority: WorkspaceAuthority; result: WorkspaceOpenResult },
  hostId: string,
  previousJti?: string,
) {
  const { authority, result } = context
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
      backing: "cloud-vm",
      // A provisioned sandbox is a non-loopback workspace-runtime exposure, so
      // `createWorkspaceRuntimeApp` composes `remoteWorkspaceSessionAccessPolicyFromEnv()`
      // and reports `sessionAuthority: "managed-private"`: sessions are
      // registered with the control plane, and its `wr/events` asks the
      // control plane who may read what — an admitted principal unscoped, a
      // share grantee for one session.
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

/**
 * The connect path (POST `/:id/connection`, POST `/:id/connection/refresh`):
 * the only verb that runs `sandboxManager.ensure`, so starting compute always
 * traces to an explicit connect — never to a read (P-118).
 */
export async function cloudConnectionInfo(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  ws: Workspace,
  previousJti?: string,
) {
  const gate = await cloudWorkspaceGate(services, auth, ws)
  if ("error" in gate) return gate
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
  return mintSignedCloudConnection(services, options, auth, ws, gate, target.hostId, previousJti)
}

/**
 * The read path (GET `/:id/connection`): reports the lease's CURRENT state
 * without provisioning. `sandboxManager.target` resolves from the lease row
 * alone — no driver call, no acquire, no boot — so a read can never start
 * compute:
 *
 *  - lease ready → the running workspace's connection, with a freshly minted
 *    Runtime Access Token,
 *  - lease acquiring → `status: "provisioning"`: an explicit connect is
 *    already booting it,
 *  - anything else (missing, stopped, unavailable, destroyed) →
 *    `status: "stopped"`, the not-running indicator an explicit POST turns
 *    into a start.
 */
export async function cloudConnectionStatus(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  ws: Workspace,
) {
  const gate = await cloudWorkspaceGate(services, auth, ws)
  if ("error" in gate) return gate
  const sandboxManager = services?.sandbox.sandboxManager
  if (!sandboxManager) {
    return {
      error: apiError("cloud_runtime_unavailable", "Cloud runtime is unavailable"),
      status: 409,
    } as const
  }
  const target = await sandboxManager.target(ws.id)
  if (target.status !== "ready") {
    return {
      connection: {
        status: target.leaseStatus === "acquiring" ? ("provisioning" as const) : ("stopped" as const),
        workspaceId: ws.id,
        ...(target.retryAfterMs !== undefined ? { retryAfterMs: target.retryAfterMs } : {}),
      },
    } as const
  }
  return mintSignedCloudConnection(services, options, auth, ws, gate, target.hostId)
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

async function localLoopbackConnection(
  options: WorkspaceRouteOptions,
  request: Request,
  ws: Workspace,
  current: Workspace,
  hostId: string,
) {
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
  return localLoopbackConnection(options, request, ws, current, target.hostId)
}

/** The loopback counterpart of `cloudConnectionStatus`: a read, never an ensure. */
export async function localLoopbackCloudConnectionStatus(
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
  const sandboxManager = services?.sandbox.sandboxManager
  if (!sandboxManager) {
    return {
      error: apiError("cloud_runtime_unavailable", "Cloud runtime is unavailable"),
      status: 409,
    } as const
  }
  const target = await sandboxManager.target(ws.id)
  if (target.status !== "ready") {
    return {
      connection: {
        status: target.leaseStatus === "acquiring" ? ("provisioning" as const) : ("stopped" as const),
        workspaceId: ws.id,
        ...(target.retryAfterMs !== undefined ? { retryAfterMs: target.retryAfterMs } : {}),
      },
    } as const
  }
  const current = (await resolveWorkspace({ workspaceId: ws.id })) ?? ws
  return localLoopbackConnection(options, request, ws, current, target.hostId)
}

function localLoopbackRelayUrl(request: Request, options: WorkspaceRouteOptions) {
  return configuredRelayUrl(options) ?? new URL(request.url).origin
}
