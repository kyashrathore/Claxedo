import type { ContentfulStatusCode } from "hono/utils/http-status"
import type { SandboxTargetResult } from "@claxedo/sandbox-manager"
import type { ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"
import type { ControlPlaneServices } from "../authority/services"
import type { CloudCreateAdmission, CloudCreateCaller, CloudCreateUsage } from "./cloud-create-admission"
import { startElapsedMs } from "../connections/cloud-start-progress"
import { apiError, captureWorkspaceTelemetry, type CloudWorkspaceEntitlementGate } from "./route-support"
import type { SandboxStart, SandboxStartAnswer, SandboxStartRequest } from "./sandbox-start"

export type CloudStartDenial = {
  error: ReturnType<typeof apiError>
  status: ContentfulStatusCode
}

/** A start's answer, or the admission that refused it before anything started. */
export type CloudStartOutcome = { denied: CloudStartDenial } | SandboxStartAnswer

export type FirstLease = {
  readonly admission: Pick<CloudCreateAdmission, "capLease">
  readonly usage: CloudCreateUsage | undefined
}

/** A lease in one of these holds no running machine, so a start of it puts one up. */
const HOST_DOWN: ReadonlySet<string> = new Set(["stopped", "unavailable", "destroyed"])

/**
 * The cap a start that puts the workspace's machine up answers to (its first
 * lease, or a wake of one that holds none), and the meter it runs if its own
 * acquire creates the first lease: two first starts racing both pass the cap,
 * and only the one that wins the acquire meters. A start joining one in
 * flight, or of a machine already up, is counted already.
 */
async function leaseAdmission(
  services: ControlPlaneServices | undefined,
  lease: FirstLease,
  caller: CloudCreateCaller,
  input: { workspaceId: string; orgId: string | undefined; current: SandboxTargetResult },
): Promise<{ denied: CloudStartDenial } | (() => void) | undefined> {
  const { current } = input
  if (current.status !== "unavailable") return undefined
  const opens = current.reason === "runtime_lease_missing"
  const wakes = current.reason === "runtime_lease_not_ready" && current.leaseStatus !== undefined && HOST_DOWN.has(current.leaseStatus)
  if (!opens && !wakes) return undefined
  const denied = await lease.admission.capLease(caller, input.orgId)
  if (denied) return { denied: { error: denied.body.error, status: denied.status } }
  if (!opens) return undefined
  const placed = await services?.sandbox.workspaceDriver?.(input.workspaceId)
  return () => lease.usage?.leaseOpened({
    caller,
    workspaceId: input.workspaceId,
    driver: placed?.id ?? "unknown",
    startedAt: Date.now(),
    ...(services ? { services } : {}),
  })
}

/**
 * The one way a cloud workspace's machine is started: the lease cap and the
 * first lease's meter, then the workspace's sandbox start, which begins a run or joins
 * the one in flight and answers at once. A person's explicit connect starts
 * it as the signed caller; a tool call of a session served by its own host
 * starts it as the workspace's owner. Every start that decided something is
 * recorded as `sandbox.ensure`; a poll that joined the run in flight is not.
 */
export async function startCloudWorkspace(
  services: ControlPlaneServices | undefined,
  start: SandboxStart,
  lease: FirstLease,
  caller: CloudCreateCaller,
  input: { workspaceId: string; orgId: string | undefined; homeRegion?: ClaxedoRegion; current: SandboxTargetResult; request?: SandboxStartRequest },
): Promise<CloudStartOutcome> {
  const { workspaceId } = input
  const meter = await leaseAdmission(services, lease, caller, input)
  if (meter && typeof meter !== "function") return meter
  const started = await start(workspaceId, input.request)
  if (started.status === "provisioning" && started.opened) {
    meter?.()
    await Promise.resolve(lease.usage?.recordLeaseTenant({ caller, workspaceId }))
      .catch((cause: unknown) => console.error(`[workspace] the lease tenant of ${workspaceId} was not recorded`, cause instanceof Error ? cause.message : String(cause)))
  }
  if (!(started.status === "provisioning" && started.joined)) {
    captureWorkspaceTelemetry({
      services,
      ...(caller.kind === "signed" ? { auth: caller.auth } : {}),
      event: "sandbox.ensure",
      workspaceId,
      orgId: input.orgId ?? (caller.kind === "owner" ? caller.owner.orgId : undefined),
      properties: {
        status: started.status,
        ...(input.homeRegion ? { homeRegion: input.homeRegion } : {}),
        ...(caller.kind === "owner" ? { startedBy: "session_host_tool" } : {}),
        ...(started.status === "provisioning" ? { leaseEpoch: started.epoch, retryAfterMs: started.retryAfterMs } : {}),
        ...(started.status === "unavailable" ? { retryAfterMs: started.retryAfterMs } : {}),
        ...(started.status === "failed" ? { code: started.code } : {}),
        ...(started.status === "ready" ? { hostId: started.hostId, leaseEpoch: started.epoch } : {}),
      },
    })
  }
  return started
}

type ProvisioningAnswer = Extract<SandboxStartAnswer, { status: "provisioning" }>

/** An owner start's answer; one still provisioning says how long its start has run when the lease records it. */
export type OwnerMachineStartAnswer = Exclude<CloudStartOutcome, ProvisioningAnswer> | (ProvisioningAnswer & { sinceStartMs?: number })

export type OwnerMachineStart = (input: { owner: { userId: string; orgId: string }; workspaceId: string }) => Promise<OwnerMachineStartAnswer>

/**
 * A workspace machine started for its owner by something other than their own
 * request: the deployment's cloud-workspace admission for the owner's
 * organization, then the one start.
 */
export function ownerMachineStart(services: ControlPlaneServices, options: {
  start: SandboxStart
  lease: FirstLease
  entitlement?: CloudWorkspaceEntitlementGate
}): OwnerMachineStart {
  return async ({ owner, workspaceId }) => {
    const denied = await options.entitlement?.({ orgId: owner.orgId })
    if (denied) return { denied: { error: denied.body.error, status: denied.status } }
    const hostManager = services.sandbox.sandboxManager
    if (!hostManager) return { denied: { error: apiError("sandbox_unavailable", "Cloud sandbox is not configured"), status: 503 } }
    const current = await hostManager.target(workspaceId)
    const started = await startCloudWorkspace(services, options.start, options.lease, { kind: "owner", owner }, { workspaceId, orgId: owner.orgId, current })
    if ("denied" in started || started.status !== "provisioning") return started
    const sinceStartMs = startElapsedMs(current, started.epoch)
    return sinceStartMs === undefined ? started : { ...started, sinceStartMs }
  }
}
