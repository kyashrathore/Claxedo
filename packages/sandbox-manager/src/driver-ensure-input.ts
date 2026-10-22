import type { SandboxDriver, SandboxDriverEnsureInput, SandboxLease, SandboxManagerInput, SandboxRegion } from "./contract"
import { DEFAULT_WORKSPACE_RUNTIME_PORT } from "./constants"
import { sandboxEgressDisposition, sandboxNetworkPolicyWithBrokeredHosts } from "./egress-policy"

function sandboxId(driver: string, workspaceId: string) {
  return `${driver}-${workspaceId}`
}

export function leaseHostId(driver: SandboxDriver, workspaceId: string, lease: SandboxLease, managerInput: SandboxManagerInput | undefined) {
  return managerInput?.hostId ?? lease.hostId ?? sandboxId(driver.id, workspaceId)
}

/**
 * Build the driver-facing ensure input.
 *
 * This is the ONLY place a `SandboxDriverEnsureInput` is constructed, which is
 * what makes the egress guarantee structural rather than a promise kept by each
 * call site: `net` is copied across only when `sandboxEgressDisposition` says
 * the driver can enforce it. A driver declaring `egressControl: "none"` — every
 * driver that throws on a restricted policy, plus the two that silently drop it
 * — cannot be reached by one through any path.
 */
export function ensureHostInput(input: {
  driver: SandboxDriver
  workspaceId: string
  lease: SandboxLease
  homeRegion: SandboxRegion
  managerInput?: SandboxManagerInput
  leaseEnv?: Record<string, string>
  appLabel: string
}): SandboxDriverEnsureInput {
  const egress = sandboxEgressDisposition(input.driver.metadata.egressControl, input.managerInput?.net)
  const labels = {
    app: input.appLabel,
    workspaceId: input.workspaceId,
    epoch: String(input.lease.epoch),
    homeRegion: input.homeRegion,
    ...input.managerInput?.labels,
  }
  return {
    workspaceId: input.workspaceId,
    hostId: leaseHostId(input.driver, input.workspaceId, input.lease, input.managerInput),
    homeRegion: input.homeRegion,
    epoch: input.lease.epoch,
    labels,
    bootSource: input.managerInput?.bootSource
      ?? (
        input.lease.checkpoint
        && input.lease.status !== "ready"
        && input.driver.metadata.persistence.resume === "replacement-restore"
          ? { kind: "driver-snapshot", snapshotId: input.lease.checkpoint.providerReference }
          : { kind: "default" }
      ),
    workspaceRoot: input.managerInput?.workspaceRoot ?? "/workspace",
    runtimeCwd: input.managerInput?.runtimeCwd,
    workspaceRuntimePort: input.managerInput?.workspaceRuntimePort ?? DEFAULT_WORKSPACE_RUNTIME_PORT,
    env: { ...input.managerInput?.env, ...input.leaseEnv },
    // Brokered secrets ride their own channel — NEVER merged into labels or env.
    // Presence of the key, not its length, is the signal: `[]` is the caller
    // withdrawing every brokered secret, and dropping it would reach the driver
    // as "preserve what you have".
    ...(input.managerInput?.secrets ? { secrets: input.managerInput.secrets } : {}),
    source: input.managerInput?.source,
    ...(input.managerInput?.updateImage ? { updateImage: true } : {}),
    ...(input.lease.machineClass ?? input.managerInput?.machineClass
      ? { machineClass: input.lease.machineClass ?? input.managerInput?.machineClass }
      : {}),
    exposure:
      input.managerInput?.exposure ??
      (input.driver.metadata.targetAccess === "loopback" ? { kind: "loopback" } : { kind: "relay" }),
    // Withheld, never downgraded: `undefined` here is the same shape a caller
    // that asked for no containment produces, so the throwing drivers take
    // their allow-all path and their throws stay intact for anyone who hands
    // them a policy directly.
    ...(egress.action === "enforce" && input.managerInput?.net
      ? { net: sandboxNetworkPolicyWithBrokeredHosts(input.managerInput.net, input.managerInput.secrets) }
      : {}),
    snapshot: input.managerInput?.snapshot,
  }
}
