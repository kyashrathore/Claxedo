import type {
  SandboxLeaseStore,
  SandboxMutationResult,
  SandboxRuntimeSnapshotInput,
} from "."

/**
 * How a deployment moves a lease's retry budget when its runtime reports on
 * itself. Two answers, both deliberate:
 *
 * - `demote` — an unhealthy report stops the lease resolving for routing and
 *   moves nothing else, so a reporting sandbox cannot spend a budget it does
 *   not own; the next `ensure` decides what happens. The default, and what a
 *   manager whose only observer is the runtime itself wants.
 * - `retry-budget` — the report also spends the budget, the way a supervisor
 *   running its own health monitor over the same sandbox already spends it.
 *   Chosen where a lease has TWO observers of one sandbox: leaving them to
 *   write different shapes for the same unhealthy minute is the divergence
 *   this removes. It must hand the budget back on the next serving report,
 *   or a flapping runtime walks its own lease into a terminal `failed`.
 */
export type SandboxRuntimeLivenessPolicy =
  | { kind: "demote" }
  | {
    kind: "retry-budget"
    /** `undefined` means the budget is spent: the lease stays unavailable until an operator acts. */
    nextRetryAt: (input: { retryCount: number; now: number }) => number | undefined
  }

const RUNTIME_UNHEALTHY = "runtime_unhealthy"

/**
 * The one writer of a lease's liveness, shared by `SandboxManager`'s
 * register/heartbeat and by any supervisor that probes the same question for
 * itself. A second implementation of this sequence is how one deployment ends
 * up able to revive a lease another deployment refuses to.
 *
 * Liveness only: identity stays whatever `recordTarget` wrote from the
 * driver's answer (@see SandboxRuntimeSnapshotInput). It takes a
 * `SandboxLeaseStore` and no driver, because recording that a sandbox is
 * alive must not depend on provider credentials the deployment may no longer
 * hold.
 *
 * Fenced twice — on the epoch the reporter names, and on the status read here
 * — because the guards below and the write are separate transactions, and a
 * stop, a destroy or a replacement epoch can land between them.
 */
export async function applySandboxRuntimeSnapshot(input: {
  leaseStore: SandboxLeaseStore
  workspaceId: string
  snapshot: SandboxRuntimeSnapshotInput
  now?: () => number
  liveness?: SandboxRuntimeLivenessPolicy
}): Promise<SandboxMutationResult> {
  const { leaseStore, workspaceId, snapshot } = input
  const liveness = input.liveness ?? { kind: "demote" }
  const current = await leaseStore.get(workspaceId)
  if (!current) return { ok: false, reason: "runtime_lease_missing" }
  if (current.epoch !== snapshot.epoch) return { ok: false, reason: "runtime_lease_epoch_mismatch" }
  // A snapshot reports on a sandbox the provisioner already placed. Moving a
  // lease that holds no target to "ready" would publish a serving address no
  // driver in this process ever returned.
  if (!current.sandboxId || !current.url || !current.hostId) {
    return { ok: false, reason: "runtime_lease_not_provisioned" }
  }
  // Stopping and destroying are decisions of the lifecycle owner. A report
  // from the sandbox is not how either is reversed.
  if (current.status === "stopped" || current.status === "destroyed") {
    return { ok: false, reason: "runtime_lease_not_serving" }
  }
  const timestamp = snapshot.now ?? (input.now ?? Date.now)()
  const retry = liveness.kind === "retry-budget"
  const updated = await leaseStore.update(workspaceId, snapshot.epoch, {
    status: snapshot.ok ? "ready" : "unavailable",
    lastHeartbeatAt: timestamp,
    ...(snapshot.active ? { lastActivityAt: timestamp } : {}),
    ...(snapshot.ok ? { lastError: null } : {}),
    ...(retry && snapshot.ok ? { retryCount: 0, nextRetryAt: null } : {}),
    ...(retry && !snapshot.ok
      ? {
        retryCount: current.retryCount + 1,
        nextRetryAt: liveness.nextRetryAt({ retryCount: current.retryCount + 1, now: timestamp }) ?? null,
        lastError: RUNTIME_UNHEALTHY,
      }
      : {}),
  }, current.status)
  if (!updated) return { ok: false, reason: await refusedReason(leaseStore, workspaceId, snapshot.epoch) }
  return { ok: true, status: updated.status }
}

/**
 * Why the fenced write was refused, read back from the lease rather than
 * assumed: the caller is told which of the three lifecycle decisions raced it,
 * and a heartbeat that lost to a stop does not report a stale epoch.
 */
async function refusedReason(leaseStore: SandboxLeaseStore, workspaceId: string, epoch: number) {
  const current = await leaseStore.get(workspaceId)
  if (!current) return "runtime_lease_missing"
  if (current.epoch !== epoch) return "runtime_lease_epoch_mismatch"
  return "runtime_lease_not_serving"
}
