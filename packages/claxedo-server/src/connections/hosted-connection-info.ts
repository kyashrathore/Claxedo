import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import { requireAuthority, type WorkspaceAuthority, type WorkspaceOpenResult } from "@claxedo/server-core/platform/auth/authority"
import { normalizeClaxedoRegion, type ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import {
  apiError,
  captureWorkspaceTelemetry,
  workspaceOrgId,
  configuredRelayUrl,
  configuredRuntimeAccessTokenSigner,
  relayRole,
  type WorkspaceRouteOptions,
} from "../workspace/route-support"
import { hostTunnelConnectionInfo, type OpenedWorkspace } from "./host-tunnel-connection"
import {
  previousRuntimeAccessTokenError,
  resolvedActor,
  runtimeTokenOrgId,
  settledActor,
  workspaceOpenAuthorizationError,
} from "../workspace/runtime-token-guards"
import type { RuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { cloudRuntimeLifecycle } from "@claxedo/server-core/workspace/cloud-runtime-readiness"
import { sandboxCheckpointUnusable, sandboxLeaseEndedUnderStart, sandboxRuntimeBootFailure, sandboxStartFailureReason, type SandboxManager, type SandboxTargetResult } from "@claxedo/sandbox-manager"
import { sessionHostAdmits } from "../authority/session-hosts"
import { workspaceRoleAllowsWrite } from "../authority/pulled-session"
import { mintSessionHostConnection } from "./session-host-connection"
import { provisioningConnection } from "./cloud-start-progress"
import { startCloudWorkspace, type CloudStartDenial, type FirstLease } from "../workspace/cloud-workspace-start"

type HostedConnectionDenial = CloudStartDenial

type CloudConnectionIngress =
  | HostedConnectionDenial
  | { tunnel: OpenedWorkspace }
  | (OpenedWorkspace & {
      hostManager: SandboxManager
      homeRegion: ClaxedoRegion
      relayUrl: string
      target: SandboxTargetResult
    })

/**
 * Everything a connection request shares BEFORE it decides whether to spend:
 * open authorization, the backing check, cloud-workspace admission and
 * relay/host-manager resolution. The caller's actor and the sandbox lease are
 * read in the open's own round, since both are keyed by ids the request
 * carries, and neither leaves this Worker unless the open admits the caller.
 * `sandboxManager.ensure` — the call that can start billable compute — is
 * deliberately NOT here: it is what separates the connect path
 * (`hostedConnectionInfo`, POST) from the read path (`hostedConnectionStatus`,
 * GET).
 */
async function cloudConnectionIngress(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  workspaceId: string,
): Promise<CloudConnectionIngress> {
  const authority = requireAuthority(services)
  const hostManager = services?.sandbox.sandboxManager
  const actor = settledActor(authority, auth)
  const [result, target] = await Promise.all([authority.openWorkspace(auth, { workspaceId }), hostManager?.target(workspaceId)])
  const authz = await workspaceOpenAuthorizationError(services, auth, result, workspaceId)
  if (authz) return authz
  if (result.workspace?.backing === "local-worktree") {
    return { tunnel: { authority, result, workspace: result.workspace, actor } } as const
  }
  if (result.workspace?.backing !== "cloud-vm") {
    return {
      error: apiError("workspace_relay_unsupported", "Workspace connection is only available for a workspace placed on a machine or in the cloud"),
      status: 400,
    } as const
  }
  // Cloud-workspace admission is enforced at wake/resume as well as at
  // create, so a deployment that stops admitting cloud workspaces cannot leave
  // existing ones wake-able. Reached ONLY for HOSTED `cloud-vm` workspaces,
  // asserted above; the hook is wired through hosted-core-app.ts's
  // HostedWorkspaceRoutes mount. A denial is answered BEFORE any sandbox wake
  // side effect.
  //
  // It gates the READ path too: the read still mints a Runtime Access Token
  // for a workspace whose sandbox is already running.
  if (options.requireCloudWorkspaceEntitlement) {
    const denied = await options.requireCloudWorkspaceEntitlement({ auth })
    if (denied) return { error: denied.body.error, status: denied.status } as const
  }
  if (!hostManager || !target) {
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
    orgId: workspaceOrgId(result.workspace),
    properties: {
      backing: "cloud-vm",
      homeRegion,
    },
  })
  return { authority, result, workspace: result.workspace, actor, hostManager, homeRegion, relayUrl, target }
}

/** A lease that ended under the start was somebody's decision, not a failure to show; any other step error is told as its reason. */
function startFailure(error: string | undefined) {
  return error && !sandboxLeaseEndedUnderStart(error) ? sandboxStartFailureReason(error) : undefined
}

/**
 * The mint tail both paths share once a ready sandbox target exists. The
 * actor was resolved beside the open, and the token's record and its audit
 * row are independent writes, so the tail costs the store one round trip
 * after the signature.
 */
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
    target: { hostId: string; epoch: number; routingId?: string; driverResourceId?: string }
    actor: RuntimeActor
    previousJti?: string
  },
) {
  const { authority, result, workspaceId, homeRegion, relayUrl, target, actor, previousJti } = input
  const previousToken = await previousRuntimeAccessTokenError(services, auth, {
    previousJti,
    workspaceId,
    hostId: target.hostId,
  })
  if (previousToken) return previousToken

  const role = relayRole(result.role)
  const signer = configuredRuntimeAccessTokenSigner(options)
  const orgId = await runtimeTokenOrgId(authority, auth, result.workspace)
  const token = await signer({
    principalKind: "user",
    ...actor,
    orgId,
    workspaceId,
    hostId: target.hostId,
    routingId: target.routingId,
    role,
  })
  await Promise.all([
    authority.recordRuntimeAccessToken(auth, {
      jti: token.jti,
      workspaceId,
      hostId: target.hostId,
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
        hostId: target.hostId,
        expiresAt: token.tokenExpiresAt,
        backing: "cloud-vm",
        homeRegion,
        leaseEpoch: target.epoch,
        ...(target.driverResourceId ? { driverResourceId: target.driverResourceId } : {}),
        relayRoom: workspaceId,
        relayUrl,
      },
    }),
  ])
  captureWorkspaceTelemetry({
    services,
    auth,
    event: "runtime_access_token.minted",
    workspaceId,
    orgId,
    properties: { backing: "cloud-vm", role, homeRegion, leaseEpoch: target.epoch },
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
 * a person's route that begins a sandbox start, so starting billable compute
 * traces to an explicit connect or to a session host's tool call
 * (`/turn-execution`), never to a read. Both start through
 * `startCloudWorkspace`, whose start answers at once: a Worker cuts work held
 * past a response, and a cold start outlives any request.
 */
export async function hostedConnectionInfo(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  workspaceId: string,
  lease: FirstLease,
  connect: { previousJti?: string; retry?: true } = {},
) {
  const { previousJti, retry } = connect
  const ingress = await cloudConnectionIngress(services, options, auth, workspaceId)
  if ("error" in ingress) return ingress
  if ("tunnel" in ingress) {
    return hostTunnelConnectionInfo(services, options, auth, workspaceId, ingress.tunnel, previousJti)
  }
  const { authority, result, homeRegion, relayUrl, target: current, actor } = ingress
  if (!options.sandboxStart) {
    return { error: apiError("sandbox_unavailable", "Cloud sandbox is not configured"), status: 503 } as const
  }

  const started = await startCloudWorkspace(services, options.sandboxStart, lease, { kind: "signed", auth }, { workspaceId, orgId: workspaceOrgId(result.workspace), homeRegion, current, ...(retry ? { request: { retry } } : {}) })
  if ("denied" in started) return started.denied
  if (started.status === "provisioning") {
    return {
      connection: provisioningConnection({
        workspaceId,
        homeRegion,
        epoch: started.epoch,
        retryAfterMs: started.retryAfterMs,
        ...(started.bootMode ? { bootMode: started.bootMode } : {}),
        ...(started.failure ? { failure: sandboxStartFailureReason(started.failure) } : {}),
      }, current),
    } as const
  }
  if (started.status === "failed") {
    return { error: apiError(started.code, started.message), status: 409 } as const
  }
  if (started.status === "unavailable") {
    captureWorkspaceTelemetry({
      services,
      auth,
      event: "workspace.connection.unavailable",
      workspaceId,
      orgId: workspaceOrgId(result.workspace),
      properties: {
        backing: "cloud-vm",
        homeRegion,
        retryAfterMs: started.retryAfterMs,
      },
    })
    // A boot that failed fails the same way until the person changes what it
    // boots from, so its reason is the answer rather than a wait.
    const unusable = sandboxCheckpointUnusable(started.error)
    if (unusable) {
      return { error: apiError("workspace_checkpoint_unusable", unusable.message, { cause: unusable.cause }), status: 409 } as const
    }
    if (started.error && sandboxRuntimeBootFailure(started.error) !== undefined) {
      return { error: apiError("cloud_runtime_boot_failed", sandboxStartFailureReason(started.error)), status: 409 } as const
    }
    const failure = startFailure(started.error)
    return {
      error: apiError("cloud_runtime_unavailable", failure ?? "Cloud runtime is unavailable", {
        retryAfterMs: started.retryAfterMs,
        ...(failure ? { failure } : {}),
      }),
      status: 409,
    } as const
  }

  return mintCloudConnection(services, options, auth, {
    authority,
    result,
    workspaceId,
    homeRegion,
    relayUrl,
    target: started,
    actor: resolvedActor(await actor),
    previousJti,
  })
}

/**
 * The connect path for a session the control plane reserved in its own
 * Durable Object (POST `/:id/connection` naming the session): its host's
 * connection, minted before the session is registered so the create itself
 * travels there. Any other session is refused; it is reached through the
 * workspace's connection.
 */
export async function hostedSessionHostConnection(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  input: { workspaceId: string; sessionId: string },
) {
  const { workspaceId, sessionId } = input
  const [ingress, placement] = await Promise.all([
    cloudConnectionIngress(services, options, auth, workspaceId),
    services?.sessionHosts?.readSessionHostPlacement({ workspaceId, sessionId }),
  ])
  if ("error" in ingress) return ingress
  if ("tunnel" in ingress || !sessionHostAdmits(placement, { workspaceId, sessionId })) {
    return { error: apiError("session_host_unavailable", "This session is not served by its own host"), status: 409 } as const
  }
  if (!workspaceRoleAllowsWrite(ingress.result.role)) {
    return { error: apiError("workspace_authorization_denied", "Creating a session needs write access to the workspace"), status: 403 } as const
  }
  const [orgId, actor] = await Promise.all([runtimeTokenOrgId(ingress.authority, auth, ingress.workspace), ingress.actor])
  return mintSessionHostConnection(ingress.authority, options, auth, {
    workspaceId,
    sessionId,
    actor: resolvedActor(actor),
    orgId,
    homeRegion: ingress.homeRegion,
    relayUrl: ingress.relayUrl,
    role: "editor",
  })
}

/** A read may inspect settings and mint for a running runtime, but never acquire a lease or provision it. */
export async function hostedConnectionStatus(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  workspaceId: string,
) {
  const ingress = await cloudConnectionIngress(services, options, auth, workspaceId)
  if ("error" in ingress) return ingress
  if ("tunnel" in ingress) {
    return hostTunnelConnectionInfo(services, options, auth, workspaceId, ingress.tunnel)
  }
  const { authority, result, homeRegion, relayUrl, target, actor } = ingress

  const running = await options.sandboxInFlight?.(workspaceId)
  // A lease reads ready through the run that replaces its sandbox; the run,
  // not the runtime it is replacing, is what this read reports.
  if (running?.status === "provisioning") {
    return {
      connection: provisioningConnection({
        workspaceId,
        homeRegion,
        epoch: running.epoch,
        retryAfterMs: running.retryAfterMs,
        ...(running.bootMode ? { bootMode: running.bootMode } : {}),
        ...(running.failure ? { failure: sandboxStartFailureReason(running.failure) } : {}),
      }, target),
    } as const
  }
  captureWorkspaceTelemetry({
    services,
    auth,
    event: "sandbox.target",
    workspaceId,
    orgId: workspaceOrgId(result.workspace),
    properties: {
      status: target.status,
      homeRegion,
      ...(target.status === "unavailable" ? { reason: target.reason, leaseStatus: target.leaseStatus } : {}),
      ...(target.status === "ready" ? { hostId: target.hostId, leaseEpoch: target.epoch } : {}),
    },
  })
  if (target.status !== "ready") {
    // The same reading the catalog row gives: a boot that failed says so, with its reason, rather than reading as asleep.
    const lifecycle = cloudRuntimeLifecycle(target)
    if (lifecycle.status === "provisioning") {
      return {
        connection: provisioningConnection({
          workspaceId,
          homeRegion,
          ...(target.retryAfterMs !== undefined ? { retryAfterMs: target.retryAfterMs } : {}),
          ...(lifecycle.failure ? { failure: lifecycle.failure } : {}),
        }, target),
      } as const
    }
    return {
      connection: {
        status: lifecycle.status,
        workspaceId,
        homeRegion,
        ...(lifecycle.status === "failed" ? { error: lifecycle.error, ...(lifecycle.checkpointUnusable ? { checkpointUnusable: lifecycle.checkpointUnusable } : {}) } : {}),
        ...(target.retryAfterMs !== undefined ? { retryAfterMs: target.retryAfterMs } : {}),
      },
    } as const
  }
  // A start re-ensures the sandbox, which boots the deployment's image and keeps the workspace's files.
  if (target.imageOutdated) {
    return { error: apiError("cloud_runtime_image_outdated", "This cloud workspace runs an older version. Restart it to update."), status: 409 } as const
  }
  try {
    if (options.runtimeProvisioned && !(await options.runtimeProvisioned({ workspaceId }))) {
      return { connection: { status: "provisioning" as const, workspaceId, homeRegion } }
    }
  } catch (cause) {
    return { error: apiError("runtime_provision_failed", cause instanceof Error ? cause.message : "Runtime settings status unavailable"), status: 409 } as const
  }
  return mintCloudConnection(services, options, auth, {
    authority,
    result,
    workspaceId,
    homeRegion,
    relayUrl,
    target,
    actor: resolvedActor(await actor),
  })
}

/**
 * One session's connection (GET `/:id/connection?sessionId=`): a Runtime
 * Access Token scoped to that session alone. A session served by its own
 * Durable Object is reached there, as an editor by whoever may send its turns
 * and as a viewer otherwise; any other session's token is a viewer's, minted
 * off whatever already serves the workspace. It opens nothing of the
 * workspace, reads its organization from the owner's record only once the
 * caller has proven they may read the session, and never starts compute: a
 * machine that is offline or a sandbox that is not running answers
 * `workspace_host_offline`.
 */
export async function hostedSessionConnection(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  input: { workspaceId: string; sessionId: string },
) {
  const { workspaceId, sessionId } = input
  const authority = requireAuthority(services)
  const settled = settledActor(authority, auth)
  await authority.authorizeSessionRead(auth, { workspaceId, sessionId })
  const [owner, placement] = await Promise.all([
    authority.resolveWorkspaceOwner?.(workspaceId),
    services?.sessionHosts?.readSessionHostPlacement({ workspaceId, sessionId }),
  ])
  if (owner && placement?.session && sessionHostAdmits(placement, { workspaceId, sessionId })) {
    const homeRegion = normalizeClaxedoRegion(undefined, options.defaultHomeRegion)
    const relayUrl = configuredRelayUrl(options, homeRegion)
    if (!relayUrl) throw new ControlPlaneAuthError(503, "runtime_access_token_signer_unavailable", "Workspace Relay URL is not configured")
    const [writes, actor] = await Promise.all([
      authority.authorizeSessionWrite(auth, { workspaceId, sessionId }).then(() => true, (error: unknown) => {
        if (error instanceof ControlPlaneAuthError && error.status === 403) return false
        throw error
      }),
      settled,
    ])
    return mintSessionHostConnection(authority, options, auth, { workspaceId, sessionId, actor: resolvedActor(actor), orgId: owner.orgId, homeRegion, relayUrl, role: writes ? "editor" : "viewer" })
  }
  const [machine, sandbox, actor] = await Promise.all([
    services?.relay.hostTunnelResolver?.(workspaceId),
    services?.sandbox.sandboxManager?.target(workspaceId).catch(() => undefined),
    settled,
  ])
  const target = machine?.active
    ? { backing: "local-worktree" as const, hostId: machine.hostId }
    : sandbox?.status === "ready"
      ? { backing: "cloud-vm" as const, hostId: sandbox.hostId, routingId: sandbox.routingId }
      : undefined
  if (!owner || !target) {
    return { error: apiError("workspace_host_offline", "Nothing is serving this session's workspace right now"), status: 409 } as const
  }
  const relayUrl = configuredRelayUrl(options)
  if (!relayUrl) {
    throw new ControlPlaneAuthError(503, "runtime_access_token_signer_unavailable", "Workspace Relay URL is not configured")
  }
  const viewer = resolvedActor(actor)
  const token = await configuredRuntimeAccessTokenSigner(options)({
    principalKind: "user",
    ...viewer,
    orgId: owner.orgId,
    workspaceId,
    hostId: target.hostId,
    ...(target.backing === "cloud-vm" && target.routingId ? { routingId: target.routingId } : {}),
    role: "viewer",
    sessionId,
  })
  await Promise.all([
    authority.recordRuntimeAccessToken(auth, {
      jti: token.jti,
      workspaceId,
      hostId: target.hostId,
      actorId: viewer.actorId,
      actorKind: viewer.actorKind,
      role: "viewer",
      sessionId,
      expiresAt: token.tokenExpiresAt,
    }),
    authority.auditAllow(auth, {
      action: "runtime_access_token.minted",
      workspaceId,
      metadata: { jti: token.jti, hostId: target.hostId, expiresAt: token.tokenExpiresAt, sessionId },
    }),
  ])
  return {
    connection: {
      backing: target.backing,
      sessionAuthority: "managed-private" as const,
      workspaceId,
      sessionId,
      relayUrl,
      runtimeAccessToken: token.runtimeAccessToken,
      tokenExpiresAt: token.tokenExpiresAt,
      role: "viewer" as const,
      hostId: target.hostId,
    },
  } as const
}
