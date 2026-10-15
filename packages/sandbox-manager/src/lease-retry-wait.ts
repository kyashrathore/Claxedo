import type { SandboxLeaseStore } from "./contract"

/**
 * Ends the wait a failed start left on the workspace's lease, its retry budget
 * with it, for a change that may have fixed what the start failed on: the next
 * start runs the driver at once, as a start of its own. True when a wait was
 * lifted; a lease that is not waiting on a failed start is left as it is.
 */
export async function liftSandboxRetryWait(leaseStore: SandboxLeaseStore, workspaceId: string): Promise<boolean> {
  const lease = await leaseStore.get(workspaceId)
  if (lease?.status !== "unavailable" || (lease.retryCount === 0 && lease.nextRetryAt === undefined)) return false
  return !!(await leaseStore.update(workspaceId, lease.epoch, { retryCount: 0, nextRetryAt: null }, "unavailable"))
}
