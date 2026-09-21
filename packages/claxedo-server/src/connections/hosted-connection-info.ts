import type { ContentfulStatusCode } from "hono/utils/http-status"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import { requireAuthority, type WorkspaceAuthority, type WorkspaceOpenResult } from "@claxedo/server-core/platform/auth/authority"
import { normalizeClaxedoRegion, type ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import {
  apiError,
  captureWorkspaceTelemetry,
  configuredRelayUrl,
  configuredRuntimeAccessTokenSigner,
  relayRole,
  type WorkspaceRouteOptions,
} from "../workspace/route-support"
import { hostTunnelConnectionInfo } from "./host-tunnel-connection"
import {
  previousRuntimeAccessTokenError,
  runtimeTokenOrgId,
  workspaceOpenAuthorizationError,
} from "../workspace/runtime-token-guards"
import { resolveRuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { hostedSandboxNetworkPolicy, type SandboxManager } from "@claxedo/sandbox-manager"

type HostedConnectionDenial = {
  error: ReturnType<typeof apiError>
  status: ContentfulStatusCode
}

type CloudConnectionIngress =
  | HostedConnectionDenial
  | { tunnel: true }
  | {
      authority: WorkspaceAuthority
      result: WorkspaceOpenResult
      hostManager: SandboxManager
      homeRegion: ClaxedoRegion
      relayUrl: string
    }

/**
 * Everything a cloud connection request shares BEFORE it decides whether to
 * spend: open authorization, the backing check, the cloud entitlement gate and
 * relay/host-manager resolution. `sandboxManager.ensure` — the call that can
 * start billable compute — is deliberately NOT here: it is what separates the
 * connect path (`hostedConnectionInfo`, POST) from the read path
 * (`hostedConnectionStatus`, GET).
 */
async function cloudConnectionIngress(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  workspaceId: string,
): Promise<CloudConnectionIngress> {
  const authority = requireAuthority(services)
  const result = await authority.openWorkspace(auth, { workspaceId })
  const authz = await workspaceOpenAuthorizationError(services, auth, result, workspaceId)
  if (authz) return authz
  if (result.workspace?.backing === "local-worktree") {
    return { tunnel: true } as const
  }
  if (result.workspace?.backing !== "cloud-vm") {
    return {
      error: apiError("workspace_relay_unsupported", "Workspace connection is only available for a workspace placed on a machine or in the cloud"),
      status: 400,
    } as const
  }
  // The cloud-workspace entitlement is enforced at wake/resume as well as at
  // create: a canceled subscription would otherwise leave existing cloud
  // workspaces wake-able forever. Reached ONLY for HOSTED `cloud-vm`
  // workspaces, asserted above; the hook is composed exclusively in
  // claxedo-hosted-product-app.ts and wired through hosted-core-app.ts's
  // HostedWorkspaceRoutes mount, so self-host / local never gate. Denied → the
  // typed billing_entitlement_required (402) the frontend acts on, BEFORE any
  // sandbox wake side effect.
  //
  // It gates the READ path too: the read still mints a Runtime Access Token
  // for a workspace whose sandbox is already running, and a canceled
  // subscription must not keep minting off a warm lease either.
  if (options.requireCloudWorkspaceEntitlement) {
    const denied = await options.requireCloudWorkspaceEntitlement({ auth })
    if (denied) {
      return {
        error:
          denied.body.error ??
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
      backing: "cloud-vm",
      homeRegion,
      relayRoom: workspaceId,
    },
  })
  return { authority, result, hostManager, homeRegion, relayUrl }
}

/** The mint tail both paths share once a ready sandbox target exists. */
async function mintCloudConnection(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  input: {
    authority: WorkspaceAuthority
    result: WorkspaceOpenResult
    workspaceId: string
    homeRegion: ClaxedoRegion
    relayUrl: string
    target: { hostId: string; epoch: number; driverResourceId?: string }
    previousJti?: string
  },
) {
  const { authority, result, workspaceId, homeRegion, relayUrl, target, previousJti } = input
  const previousToken = await previousRuntimeAccessTokenError(services, auth, {
    previousJti,
    workspaceId,
    hostId: target.hostId,
  })
  if (previousToken) return previousToken

  const role = relayRole(result.role)
  const actor = await resolveRuntimeActor(authority, auth)
  const signer = configuredRuntimeAccessTokenSigner(options)
  const orgId = await runtimeTokenOrgId(authority, auth, result.workspace)
  const token = await signer({
    principalKind: "user",
    ...actor,
    orgId,
    workspaceId,
    hostId: target.hostId,
    role,
  })
  await authority.recordRuntimeAccessToken(auth, {
    jti: token.jti,
    workspaceId,
    hostId: target.hostId,
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    role,
    expiresAt: token.tokenExpiresAt,
  })
  await authority.auditAllow(auth, {
    action: "runtime_access_token.minted",
    workspaceId,
    metadata: {
      jti: token.jti,
      hostId: target.hostId,
      expiresAt: token.tokenExpiresAt,
      backing: "cloud-vm",
      homeRegion,
      leaseEpoch: target.epoch,
      ...(target.driverResourceId ? { driverResourceId: target.driverResourceId } : {}),
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
      backing: "cloud-vm",
      hostId: target.hostId,
      role,
      jti: token.jti,
      expiresAt: token.tokenExpiresAt,
      homeRegion,
      leaseEpoch: target.epoch,
      ...(target.driverResourceId ? { driverResourceId: target.driverResourceId } : {}),
      relayRoom: workspaceId,
      relayUrl,
    },
  })
  if (previousJti) {
    await authority.revokeRuntimeAccessToken(auth, { jti: previousJti, workspaceId })
  }
  return {
    connection: {
      backing: "cloud-vm" as const,
      // The hosted sandbox runs the workspace runtime behind the relay with a
      // non-loopback exposure, so it composes the remote session authority and
      // serves session-scoped event streams only. See the sibling
      // `host-tunnel-connection.ts` for the other composition.
      sessionAuthority: "managed-private" as const,
      workspaceId,
      homeRegion,
      relayUrl,
      runtimeAccessToken: token.runtimeAccessToken,
      tokenExpiresAt: token.tokenExpiresAt,
      role,
      hostId: target.hostId,
    },
  } as const
}

/**
 * The connect path (POST `/:id/connection`, POST `/:id/connection/refresh`):
 * the ONLY route that runs `sandboxManager.ensure`, so starting billable
 * compute always traces to an explicit connect — never to a read.
 */
export async function hostedConnectionInfo(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  workspaceId: string,
  controlPlaneUrl: string,
  previousJti?: string,
) {
  const ingress = await cloudConnectionIngress(services, options, auth, workspaceId)
  if ("error" in ingress) return ingress
  if ("tunnel" in ingress) {
    return hostTunnelConnectionInfo(services, options, auth, workspaceId, previousJti)
  }
  const { authority, result, hostManager, homeRegion, relayUrl } = ingress

  const runtimeContext = { workspaceId }
  let preparation
  try {
    preparation = await options.prepareRuntime?.(runtimeContext)
  } catch (cause) {
    return {
      error: apiError("runtime_prepare_failed", cause instanceof Error ? cause.message : "Runtime preparation failed"),
      status: 409,
    } as const
  }
  const ensured = await hostManager.ensure(workspaceId, {
    homeRegion,
    net: hostedSandboxNetworkPolicy({
      controlPlane: [relayUrl, controlPlaneUrl],
      source: typeof result.workspace?.repo_url === "string"
        ? { kind: "git", repoUrl: result.workspace.repo_url }
        : { kind: "empty" },
      extraHosts: options.sandboxEgressExtraHosts,
    }),
    ...(preparation?.secrets !== undefined ? { secrets: preparation.secrets } : {}),
    ...(preparation?.env ? { env: preparation.env } : {}),
  })
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
        backing: "cloud-vm",
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

  // The sandbox process being healthy is not the product-ready boundary.
  // Build-selected runtime contributions materialize their authoritative
  // state here; failure prevents token minting instead of exposing a partial VM.
  try {
    await options.provisionRuntime?.(runtimeContext, preparation)
  } catch (cause) {
    return {
      error: apiError("runtime_provision_failed", cause instanceof Error ? cause.message : "Runtime provisioning failed"),
      status: 409,
    } as const
  }

  return mintCloudConnection(services, options, auth, {
    authority,
    result,
    workspaceId,
    homeRegion,
    relayUrl,
    target: ensured,
    previousJti,
  })
}

/**
 * The read path (GET `/:id/connection`): reports the connection's CURRENT
 * state without ever provisioning. `sandboxManager.target` resolves from the
 * lease row alone — no driver call, no acquire, no boot — so a read can never
 * start billable compute:
 *
 *  - lease ready → the running workspace's connection, with a freshly minted
 *    Runtime Access Token (a viewer may legitimately need the running runtime
 *    to read a session — P-118; what a read may not do is START one),
 *  - lease acquiring → `status: "provisioning"`: an explicit connect is
 *    already booting it, and the read says so without joining the spend,
 *  - anything else (missing, stopped, unavailable, destroyed) →
 *    `status: "stopped"`, the not-running indicator an explicit POST turns
 *    into a start.
 */
export async function hostedConnectionStatus(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  workspaceId: string,
) {
  const ingress = await cloudConnectionIngress(services, options, auth, workspaceId)
  if ("error" in ingress) return ingress
  if ("tunnel" in ingress) {
    return hostTunnelConnectionInfo(services, options, auth, workspaceId)
  }
  const { authority, result, hostManager, homeRegion, relayUrl } = ingress

  const target = await hostManager.target(workspaceId)
  captureWorkspaceTelemetry({
    services,
    auth,
    event: "sandbox.target",
    workspaceId,
    properties: {
      status: target.status,
      homeRegion,
      relayRoom: workspaceId,
      ...(target.status === "unavailable" ? { reason: target.reason, leaseStatus: target.leaseStatus } : {}),
      ...(target.status === "ready" ? {
        hostId: target.hostId,
        leaseEpoch: target.epoch,
        ...(target.driverResourceId ? { driverResourceId: target.driverResourceId } : {}),
      } : {}),
    },
  })
  if (target.status !== "ready") {
    return {
      connection: {
        status: target.leaseStatus === "acquiring" ? ("provisioning" as const) : ("stopped" as const),
        workspaceId,
        homeRegion,
        ...(target.retryAfterMs !== undefined ? { retryAfterMs: target.retryAfterMs } : {}),
      },
    } as const
  }
  return mintCloudConnection(services, options, auth, {
    authority,
    result,
    workspaceId,
    homeRegion,
    relayUrl,
    target,
  })
}
