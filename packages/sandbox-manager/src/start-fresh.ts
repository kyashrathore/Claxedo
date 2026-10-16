import type { SandboxDriver, SandboxLease, SandboxLeaseStore, SandboxMutationResult, SandboxPersistenceCapabilities, SandboxResource } from "./contract"
import { discardSnapshot } from "./checkpoint-manager"
import { sandboxLeaseFailure } from "./lease-failure"
import type { createLifecycleReporter } from "./lease-lifecycle"

/**
 * Only a checkpoint captured to a new resource can be dropped for a fresh
 * start: one that is the host itself (Docker's commit) comes back on the
 * host's resume, and a driver that captures nothing has no checkpoint at all.
 */
function startsFreshFromImage(persistence: SandboxPersistenceCapabilities) {
  return persistence.capture === "filesystem" && persistence.restoreMount === "new-resource"
}

/**
 * Drops the lease's checkpoint, restore record and the failure it left, so
 * the next start boots the image and clones the repository. Refused while a
 * start or the runtime runs: a running workspace's files are not yet in any
 * checkpoint, and a start in flight would restore what this drops.
 */
export async function startSandboxFresh(input: {
  workspaceId: string
  driver: SandboxDriver
  leaseStore: SandboxLeaseStore
  lifecycle: ReturnType<typeof createLifecycleReporter>
  resource: (lease: SandboxLease) => SandboxResource | undefined
  now: number
  maxRetryCount: number
}): Promise<SandboxMutationResult> {
  if (!startsFreshFromImage(input.driver.metadata.persistence)) return { ok: false, reason: "start_fresh_unsupported" }
  const lease = await input.leaseStore.get(input.workspaceId)
  if (!lease) return { ok: false, reason: "runtime_lease_missing" }
  const failure = sandboxLeaseFailure(lease, { now: input.now, maxRetryCount: input.maxRetryCount })
  if (lease.status === "ready" || lease.status === "acquiring" || failure?.retrying) return { ok: false, reason: "workspace_running" }
  const status = lease.status === "destroyed" ? "destroyed" : "stopped"
  const updated = await input.leaseStore.update(input.workspaceId, lease.epoch, {
    status,
    checkpoint: null,
    restore: null,
    lastError: null,
    nextRetryAt: null,
    retryCount: 0,
  }, lease.status)
  if (!updated) return { ok: false, reason: "runtime_lease_changed" }
  const resource = input.resource(lease)
  if (lease.checkpoint && resource) await discardSnapshot(input.driver.deleteSnapshot, resource, lease.checkpoint.providerReference)
  input.lifecycle.startedFresh(lease, failure?.kind === "checkpoint_unusable" ? failure.cause : undefined)
  return { ok: true, status }
}
