import type { SandboxBootMode, SandboxDriver, SandboxLease, SandboxStartProgress } from "./contract"
import { sandboxLeaseFailure } from "./lease-failure"

/**
 * The boot path a lease is on, read from its row alone, for the provisioning
 * answers given before a driver step runs, so the connect UI keeps its honest
 * label across the whole wait. Mirrors the predicates the manager's step uses
 * when no caller boot source is set: the driver-snapshot default and its
 * `resuming`. A host that never published a URL never served, so resuming it
 * is the workspace's first start as the person sees it, not a wake.
 */
export function leaseBootMode(lease: SandboxLease, driver: Pick<SandboxDriver, "metadata" | "resumeHost">): SandboxBootMode {
  const restoring =
    Boolean(lease.checkpoint)
    && lease.status !== "ready"
    && driver.metadata.persistence.resume === "replacement-restore"
  if (restoring) return "restore"
  if (lease.sandboxId && lease.url && driver.resumeHost) return "resume"
  return "cold-start"
}

/**
 * The start the next epoch continues: the one a stale epoch was taken over
 * in, or the one a provider failure interrupted while its retry is scheduled
 * and its budget lasts. A boot failure, a spent budget, a lifted retry wait, a
 * lost serving runtime and a stop all end the start the person was waiting
 * on; the next epoch is a start of its own.
 */
export function continuedStart(
  lease: SandboxLease | undefined,
  input: { now: number; maxRetryCount: number },
): SandboxStartProgress | undefined {
  if (!lease?.start) return undefined
  const failure = sandboxLeaseFailure(lease, input)
  const continued = lease.status === "acquiring"
    || (failure?.kind === "provider" && lease.nextRetryAt !== undefined && lease.retryCount < input.maxRetryCount)
  if (!continued) return undefined
  return { requestedAt: lease.start.requestedAt, bootMode: lease.start.bootMode, startedAt: input.now, markedAt: input.now, phases: [] }
}
