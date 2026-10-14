import {
  isSandboxListingUnsupported,
  type SandboxDriver,
  type SandboxGarbageCollectResult,
  type SandboxLeaseStore,
  type SandboxTarget,
} from "./contract"

/**
 * Destroys every sandbox the driver lists under `appLabel` that no lease owns.
 * The lease store is authoritative for which provider resource a workspace
 * owns, so the sweep reads the provider first and the leases second: a driver
 * that cannot enumerate answers "we could not look", never "nothing is
 * orphaned", because an empty listing reaching the sweep would make every live
 * sandbox look like an orphan and destroy the fleet.
 */
export async function sweepSandboxes(input: {
  driver: SandboxDriver
  leaseStore: SandboxLeaseStore
  appLabel: string
}): Promise<SandboxGarbageCollectResult> {
  const { driver, leaseStore, appLabel } = input
  const blind = { destroyed: [], kept: [], skipped: [], failed: [], listingUnsupported: true as const, driver: driver.id }
  if (!driver.list) return blind
  let listed: SandboxTarget[]
  try {
    listed = await driver.list()
  } catch (err) {
    if (!isSandboxListingUnsupported(err)) throw err
    return blind
  }
  const leases = new Map((await leaseStore.list()).map((lease) => [lease.workspaceId, lease]))
  const result: SandboxGarbageCollectResult = { destroyed: [], kept: [], skipped: [], failed: [] }
  for (const target of listed) {
    if (target.labels?.app !== appLabel) {
      result.skipped.push({ target, reason: "unmanaged_app_label" })
      continue
    }
    const workspaceId = target.labels.workspaceId
    const epoch = target.labels.epoch
    if (!workspaceId || !epoch) {
      result.skipped.push({ target, reason: "missing_runtime_labels" })
      continue
    }
    const lease = leases.get(workspaceId)
    // Provider labels are create-time state: a driver that reuses a resource
    // across an epoch bump (a restore that keeps the same provider sandbox, a
    // resume after stop) cannot retag it atomically with the reuse, so
    // `labels.epoch` can lag the lease even after the driver rewrote it. A
    // listed sandbox the lease still names is in service whatever its labels
    // claim. Only a "destroyed" lease disclaims the resource; a remnant of it
    // is exactly what this sweep exists to finish.
    const leaseOwnsResource =
      lease !== undefined && lease.status !== "destroyed" && (
        lease.sandboxId === target.sandboxId ||
        (lease.driverResourceId !== undefined && lease.driverResourceId === target.driverResourceId)
      )
    if (leaseOwnsResource) {
      result.kept.push(target)
      continue
    }
    // An in-flight provision for the current epoch is live before the lease carries host or sandbox identity.
    if (lease?.status === "acquiring" && String(lease.epoch) === epoch) {
      result.kept.push(target)
      continue
    }
    if (!driver.destroy) {
      result.skipped.push({ target, reason: "destroy_unsupported" })
      continue
    }
    try {
      await driver.destroy(target)
      result.destroyed.push(target)
    } catch (err) {
      result.failed.push({ target, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return result
}
