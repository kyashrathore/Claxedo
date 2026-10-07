import type { ContentfulStatusCode } from "hono/utils/http-status"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import { requireAuthority, type WorkspaceAuthority, type WorkspaceOpenResult, type WorkspaceRecord } from "@claxedo/server-core/platform/auth/authority"
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
import { resolveRuntimeActor, type RuntimeActor } from "@claxedo/server-core/platform/auth/runtime-actor"
import { cloudRuntimeStartFailure } from "@claxedo/server-core/workspace/cloud-runtime-readiness"
import { sandboxRuntimeBootFailure, type SandboxManager } from "@claxedo/sandbox-manager"
import { sessionHostAdmits } from "../authority/session-hosts"
import { workspaceRoleAllowsWrite } from "../authority/pulled-session"
import { mintSessionHostConnection } from "./session-host-connection"
import type { CloudCreateAdmission, CloudCreateUsage } from "../workspace/cloud-create-admission"

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
      workspace: WorkspaceRecord
      hostManager: SandboxManager
      homeRegion: ClaxedoRegion
      relayUrl: string
    }

/**
 * Everything a cloud connection request shares BEFORE it decides whether to
 * spend: open authorization, the backing check, cloud-workspace admission and
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
    },
  })
  return { authority, result, workspace: result.workspace, hostManager, homeRegion, relayUrl }
}

type SettledActor = { actor: RuntimeActor } | { failed: unknown }

/**
 * The caller's actor, read while the sandbox is asked and held until the
 * answer says a token is minted: a sandbox that is still provisioning never
 * fails on the actor read, and a start in flight is never abandoned by it.
 */
function settledActor(authority: WorkspaceAuthority, auth: SignedControlPlaneAuth): Promise<SettledActor> {
  return resolveRuntimeActor(authority, auth).then((actor) => ({ actor }), (failed: unknown) => ({ failed }))
}

function resolvedActor(settled: SettledActor): RuntimeActor {
  if ("failed" in settled) throw settled.failed
  return settled.actor
}

/**
 * The mint tail both paths share once a ready sandbox target exists. The
 * actor was resolved while the sandbox was asked, and the token's record and
 * its audit row are independent writes, so the tail costs the store two
 * round trips after the signature rather than four.
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

/** What the start that opens a cloud workspace's first lease answers to: the lease cap, then the usage seams. */
export type FirstLease = {
  readonly admission: Pick<CloudCreateAdmission, "capLease">
  readonly usage: CloudCreateUsage | undefined
}

/**
 * The cap a start that may open the workspace's first lease answers to, and
 * the meter it runs if its own acquire creates that lease: two first starts
 * racing both pass the cap, and only the one that wins the acquire meters.
 */
async function firstLeaseMeter(
  services: ControlPlaneServices | undefined,
  lease: FirstLease,
  auth: SignedControlPlaneAuth,
  input: { workspaceId: string; hostManager: SandboxManager },
): Promise<HostedConnectionDenial | (() => void) | undefined> {
  const current = await input.hostManager.target(input.workspaceId)
  if (current.status !== "unavailable" || current.reason !== "runtime_lease_missing") return undefined
  const denied = await lease.admission.capLease({ kind: "signed", auth })
  if (denied) return { error: denied.body.error, status: denied.status }
  const placed = await services?.sandbox.workspaceDriver?.(input.workspaceId)
  return () => lease.usage?.leaseOpened({
    caller: { kind: "signed", auth },
    workspaceId: input.workspaceId,
    driver: placed?.driver.id ?? "unknown",
    ...(placed ? { keyOwner: placed.key } : {}),
    startedAt: Date.now(),
    ...(services ? { services } : {}),
  })
}

/**
 * The connect path (POST `/:id/connection`, POST `/:id/connection/refresh`):
 * the ONLY route that begins a sandbox start, so starting billable compute
 * always traces to an explicit connect — never to a read. The start itself
 * runs under `options.sandboxStart`, which answers at once: a Worker cuts
 * work held past a response, and a cold start outlives any request.
 */
export async function hostedConnectionInfo(
  services: ControlPlaneServices | undefined,
  options: WorkspaceRouteOptions,
  auth: SignedControlPlaneAuth,
  workspaceId: string,
  lease: FirstLease,
  previousJti?: string,
) {
  const ingress = await cloudConnectionIngress(services, options, auth, workspaceId)
  if ("error" in ingress) return ingress
  if ("tunnel" in ingress) {
    return hostTunnelConnectionInfo(services, options, auth, workspaceId, previousJti)
  }
  const { authority, result, hostManager, homeRegion, relayUrl } = ingress
  if (!options.sandboxStart) {
    return { error: apiError("sandbox_unavailable", "Cloud sandbox is not configured"), status: 503 } as const
  }

  const meter = await firstLeaseMeter(services, lease, auth, { workspaceId, hostManager })
  if (meter && typeof meter !== "function") return meter
  const [started, actor] = await Promise.all([options.sandboxStart(workspaceId), settledActor(authority, auth)])
  if (started.status === "provisioning" && started.opened) {
    meter?.()
    await Promise.resolve(lease.usage?.recordLeaseTenant({ caller: { kind: "signed", auth }, workspaceId }))
      .catch((cause: unknown) => console.error(`[workspace] the lease tenant of ${workspaceId} was not recorded`, cause instanceof Error ? cause.message : String(cause)))
  }
  captureWorkspaceTelemetry({
    services,
    auth,
    event: "sandbox.ensure",
    workspaceId,
    properties: {
      status: started.status,
      homeRegion,
      ...(started.status === "provisioning" ? { leaseEpoch: started.epoch, retryAfterMs: started.retryAfterMs } : {}),
      ...(started.status === "unavailable" ? { retryAfterMs: started.retryAfterMs } : {}),
      ...(started.status === "failed" ? { code: started.code } : {}),
      ...(started.status === "ready" ? {
        hostId: started.hostId,
        leaseEpoch: started.epoch,
        ...(started.driverResourceId ? { driverResourceId: started.driverResourceId } : {}),
      } : {}),
    },
  })
  if (started.status === "provisioning") {
    return {
      connection: {
        status: "provisioning" as const,
        workspaceId,
        homeRegion,
        retryAfterMs: started.retryAfterMs,
        // Which boot path this cycle is on (restore | resume | cold-start),
        // when the manager knows it — the connect UI renders it instead of a
        // generic "preparing" spinner. Absent while the lease is still queued
        // behind a retry window or another caller.
        ...(started.bootMode ? { bootMode: started.bootMode } : {}),
      },
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
      properties: {
        backing: "cloud-vm",
        homeRegion,
        retryAfterMs: started.retryAfterMs,
      },
    })
    // A boot that failed fails the same way until the person changes what it
    // boots from, so its reason is the answer rather than a wait.
    const bootFailure = sandboxRuntimeBootFailure(started.error)
    if (bootFailure) {
      return { error: apiError("cloud_runtime_boot_failed", cloudRuntimeStartFailure(bootFailure)), status: 409 } as const
    }
    return {
      error: apiError("cloud_runtime_unavailable", "Cloud runtime is unavailable", {
        retryAfterMs: started.retryAfterMs,
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
    actor: resolvedActor(actor),
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
  const ingress = await cloudConnectionIngress(services, options, auth, workspaceId)
  if ("error" in ingress) return ingress
  const placement = "tunnel" in ingress ? undefined : await services?.sessionHosts?.readSessionHostPlacement({ workspaceId, sessionId })
  if ("tunnel" in ingress || !sessionHostAdmits(placement, { workspaceId, sessionId })) {
    return { error: apiError("session_host_unavailable", "This session is not served by its own host"), status: 409 } as const
  }
  if (!workspaceRoleAllowsWrite(ingress.result.role)) {
    return { error: apiError("workspace_authorization_denied", "Creating a session needs write access to the workspace"), status: 403 } as const
  }
  return mintSessionHostConnection(ingress.authority, options, auth, {
    workspaceId,
    sessionId,
    orgId: await runtimeTokenOrgId(ingress.authority, auth, ingress.workspace),
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
    return hostTunnelConnectionInfo(services, options, auth, workspaceId)
  }
  const { authority, result, hostManager, homeRegion, relayUrl } = ingress

  const [running, target, actor] = await Promise.all([options.sandboxInFlight?.(workspaceId), hostManager.target(workspaceId), settledActor(authority, auth)])
  // A lease reads ready through the run that replaces its sandbox; the run,
  // not the runtime it is replacing, is what this read reports.
  if (running?.status === "provisioning") {
    return {
      connection: {
        status: "provisioning" as const,
        workspaceId,
        homeRegion,
        retryAfterMs: running.retryAfterMs,
        ...(running.bootMode ? { bootMode: running.bootMode } : {}),
      },
    } as const
  }
  captureWorkspaceTelemetry({
    services,
    auth,
    event: "sandbox.target",
    workspaceId,
    properties: {
      status: target.status,
      homeRegion,
      ...(target.status === "unavailable" ? { reason: target.reason, leaseStatus: target.leaseStatus } : {}),
      ...(target.status === "ready" ? { hostId: target.hostId, leaseEpoch: target.epoch } : {}),
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
    actor: resolvedActor(actor),
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
  await authority.authorizeSessionRead(auth, { workspaceId, sessionId })
  const owner = await authority.resolveWorkspaceOwner?.(workspaceId)
  const placement = await services?.sessionHosts?.readSessionHostPlacement({ workspaceId, sessionId })
  if (owner && placement?.session && sessionHostAdmits(placement, { workspaceId, sessionId })) {
    const relayUrl = configuredRelayUrl(options)
    if (!relayUrl) throw new ControlPlaneAuthError(503, "runtime_access_token_signer_unavailable", "Workspace Relay URL is not configured")
    const writes = await authority.authorizeSessionWrite(auth, { workspaceId, sessionId }).then(() => true, (error: unknown) => {
      if (error instanceof ControlPlaneAuthError && error.status === 403) return false
      throw error
    })
    return mintSessionHostConnection(authority, options, auth, { workspaceId, sessionId, orgId: owner.orgId, relayUrl, role: writes ? "editor" : "viewer" })
  }
  const machine = await services?.relay.hostTunnelResolver?.(workspaceId)
  const sandbox = machine?.active ? undefined : await services?.sandbox.sandboxManager?.target(workspaceId).catch(() => undefined)
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
  const actor = await resolveRuntimeActor(authority, auth)
  const token = await configuredRuntimeAccessTokenSigner(options)({
    principalKind: "user",
    ...actor,
    orgId: owner.orgId,
    workspaceId,
    hostId: target.hostId,
    ...(target.backing === "cloud-vm" && target.routingId ? { routingId: target.routingId } : {}),
    role: "viewer",
    sessionId,
  })
  await authority.recordRuntimeAccessToken(auth, {
    jti: token.jti,
    workspaceId,
    hostId: target.hostId,
    actorId: actor.actorId,
    actorKind: actor.actorKind,
    role: "viewer",
    sessionId,
    expiresAt: token.tokenExpiresAt,
  })
  await authority.auditAllow(auth, {
    action: "runtime_access_token.minted",
    workspaceId,
    metadata: { jti: token.jti, hostId: target.hostId, expiresAt: token.tokenExpiresAt, sessionId },
  })
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
