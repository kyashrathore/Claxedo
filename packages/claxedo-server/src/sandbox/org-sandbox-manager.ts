import {
  applySandboxRuntimeSnapshot,
  type SandboxDriver,
  type SandboxGarbageCollectResult,
  type SandboxLease,
  type SandboxLeaseStore,
  type SandboxManager,
  type SandboxManagerInput,
} from "@claxedo/sandbox-manager"
import type { SandboxSecretBrokering } from "@claxedo/sandbox-contract"
import { SandboxProviderKeyMissingError, type OrgSandboxDrivers, type SandboxKeyBinding } from "./org-sandbox-drivers"

export const SANDBOX_KEY_LABEL = "sandboxKey"
export const SANDBOX_ORG_LABEL = "sandboxOrg"

type Recorded = { key: string; orgId: string }

/**
 * One `SandboxManager` over every organization key a deployment spends. A
 * workspace's first ensure binds it to its organization's driver of the
 * moment, and the lease's labels record that key from the acquire on, so every
 * later stop, snapshot or destroy reaches the provider account that made the
 * machine even after the organization adds or switches keys. A start on a
 * lease whose machine is gone chooses again. A sweep visits every organization
 * key a live machine was made on, each through its own driver; one
 * organization's revoked or removed key cannot stop the others'.
 */
export function createOrgSandboxManager(input: {
  leaseStore: SandboxLeaseStore
  drivers: OrgSandboxDrivers
  workspaceOrg: (workspaceId: string) => Promise<string | undefined>
  manager: (driver: SandboxDriver) => SandboxManager
  now?: () => number
}) {
  const now = input.now ?? Date.now
  const managers = new WeakMap<SandboxKeyBinding, SandboxManager>()
  const managerFor = (binding: SandboxKeyBinding) => {
    const manager = managers.get(binding) ?? input.manager(binding.driver)
    managers.set(binding, manager)
    return manager
  }
  const orgOf = async (workspaceId: string, lease: SandboxLease | undefined) => {
    const orgId = recordedKey(lease)?.orgId ?? await input.workspaceOrg(workspaceId)
    if (!orgId) throw new Error(`workspace ${workspaceId} has no active owner to choose a sandbox provider for`)
    return orgId
  }
  /** The key a start spends: the one whose machine the lease still holds, else the organization's current choice. */
  const starting = async (workspaceId: string, managerInput: SandboxManagerInput) => {
    const lease = await input.leaseStore.get(workspaceId)
    const machine = machineKey(lease)
    const orgId = machine?.orgId ?? await orgOf(workspaceId, lease)
    const binding = machine ? await input.drivers.forKey(orgId, machine.key) : await input.drivers.forOrg(orgId)
    const labels = { ...managerInput.labels, [SANDBOX_KEY_LABEL]: binding.key, [SANDBOX_ORG_LABEL]: orgId }
    return { manager: managerFor(binding), input: { ...managerInput, labels } }
  }
  /**
   * The manager a lifecycle call runs on: the key that made the lease's machine; for a lease with no machine, its
   * recorded key while that key exists, else the organization's current key. None when the organization holds no key
   * at all, which is also when the workspace has no machine to reach.
   */
  const routed = async (workspaceId: string, lease: SandboxLease | undefined): Promise<SandboxManager | undefined> => {
    const machine = machineKey(lease)
    if (machine) return managerFor(await input.drivers.forKey(machine.orgId, machine.key))
    const recorded = recordedKey(lease)
    if (recorded) {
      const binding = await input.drivers.forKey(recorded.orgId, recorded.key).catch(() => undefined)
      if (binding) return managerFor(binding)
    }
    try {
      return managerFor(await input.drivers.forOrg(await orgOf(workspaceId, lease)))
    } catch (error) {
      if (error instanceof SandboxProviderKeyMissingError) return undefined
      throw error
    }
  }
  const lifecycle = async <T>(
    workspaceId: string,
    run: (manager: SandboxManager) => Promise<T>,
    keyless: (lease: SandboxLease | undefined) => T,
  ): Promise<T> => {
    const lease = await input.leaseStore.get(workspaceId)
    const manager = await routed(workspaceId, lease)
    return manager ? await run(manager) : keyless(lease)
  }
  /** A lease on an organization without a key: a start chose a key that was removed before it made a machine. */
  const refuse = (): never => {
    throw new SandboxProviderKeyMissingError()
  }
  const manager: SandboxManager = {
    ensure: async (workspaceId, managerInput) => {
      const start = await starting(workspaceId, managerInput)
      return await start.manager.ensure(workspaceId, start.input)
    },
    acquire: async (workspaceId, managerInput) => {
      const start = await starting(workspaceId, managerInput)
      return await start.manager.acquire(workspaceId, start.input)
    },
    provision: async (workspaceId, epoch, managerInput) => {
      const start = await starting(workspaceId, managerInput)
      return await start.manager.provision(workspaceId, epoch, start.input)
    },
    register: (workspaceId, snapshot) => applySandboxRuntimeSnapshot({ leaseStore: input.leaseStore, workspaceId, snapshot, now }),
    heartbeat: (workspaceId, snapshot) => applySandboxRuntimeSnapshot({ leaseStore: input.leaseStore, workspaceId, snapshot, now }),
    target: (workspaceId) => lifecycle(workspaceId, (manager) => manager.target(workspaceId), (lease) => lease ? refuse() : { status: "unavailable", reason: "runtime_lease_missing" }),
    release: async (workspaceId) => {
      if (!(await input.leaseStore.get(workspaceId))) return { released: false }
      await input.leaseStore.release(workspaceId)
      return { released: true }
    },
    touch: (workspaceId) => lifecycle(workspaceId, (manager) => manager.touch(workspaceId), (lease) => lease ? refuse() : { touched: false, status: "missing" }),
    snapshot: (workspaceId, committed) => lifecycle(workspaceId, (manager) => manager.snapshot(workspaceId, committed), (lease) => lease ? refuse() : { ok: false, reason: "runtime_lease_missing" }),
    checkpoint: (workspaceId, request) => lifecycle(workspaceId, (manager) => manager.checkpoint(workspaceId, request), refuse),
    restore: (workspaceId, request) => lifecycle(workspaceId, (manager) => manager.restore(workspaceId, request), refuse),
    stop: (workspaceId, request) => lifecycle(workspaceId, (manager) => manager.stop(workspaceId, request), (lease) => lease ? refuse() : { ok: false, reason: "runtime_lease_missing" }),
    // A keyless lease never made a machine, so there is nothing on any provider to destroy; the caller releases it.
    destroy: (workspaceId) => lifecycle(workspaceId, (manager) => manager.destroy(workspaceId), (lease) => ({ ok: false, reason: lease ? "runtime_lease_resource_missing" : "runtime_lease_missing" })),
    recordStartPhases: (workspaceId, phases) => lifecycle(workspaceId, (manager) => manager.recordStartPhases(workspaceId, phases), () => undefined),
    markStartPhase: (workspaceId, phase) => lifecycle(workspaceId, (manager) => manager.markStartPhase(workspaceId, phase), () => undefined),
    garbageCollect: async () => {
      const sweeps: SandboxGarbageCollectResult[] = []
      const unreachable: Array<{ driver: string; error: string }> = []
      for (const { key, orgId, driver } of await leasedOrgKeys(input.leaseStore)) {
        try {
          sweeps.push(await managerFor(await input.drivers.forKey(orgId, key)).garbageCollect())
        } catch (error) {
          unreachable.push({ driver, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return mergedSweeps(sweeps, unreachable)
    },
    list: () => input.leaseStore.list(),
  }
  return {
    manager,
    workspaceDriver: async (workspaceId: string): Promise<SandboxDriver> => {
      const lease = await input.leaseStore.get(workspaceId)
      const machine = machineKey(lease)
      return (machine ? await input.drivers.forKey(machine.orgId, machine.key) : await input.drivers.forOrg(await orgOf(workspaceId, lease))).driver
    },
    workspaceSecretBrokering: async (workspaceId: string): Promise<SandboxSecretBrokering> => {
      const lease = await input.leaseStore.get(workspaceId)
      const machine = machineKey(lease)
      return machine
        ? input.drivers.secretBrokering(machine.orgId, machine.key)
        : input.drivers.secretBrokering(await orgOf(workspaceId, lease))
    },
    orgDriver: async (orgId: string): Promise<SandboxDriver> => (await input.drivers.forOrg(orgId)).driver,
  }
}

/** The key a lease was taken on. Absent only for a lease nothing wrote through this manager. */
function recordedKey(lease: SandboxLease | undefined): Recorded | undefined {
  const key = lease?.labels?.[SANDBOX_KEY_LABEL]
  const orgId = lease?.labels?.[SANDBOX_ORG_LABEL]
  return key && orgId ? { key, orgId } : undefined
}

/**
 * The key a lease's machine spends. A lease that never made a machine, or whose machine was destroyed, holds nothing
 * on that key's account, so a start chooses the organization's current key instead.
 */
function machineKey(lease: SandboxLease | undefined): Recorded | undefined {
  if (!lease || lease.status === "destroyed" || !lease.sandboxId) return undefined
  return recordedKey(lease)
}

async function leasedOrgKeys(leaseStore: SandboxLeaseStore) {
  const keys = new Map<string, Recorded & { driver: string }>()
  for (const lease of await leaseStore.list()) {
    const recorded = machineKey(lease)
    if (recorded && !keys.has(recorded.key)) keys.set(recorded.key, { ...recorded, driver: lease.driver })
  }
  return [...keys.values()]
}

function mergedSweeps(sweeps: SandboxGarbageCollectResult[], unreachable: Array<{ driver: string; error: string }>): SandboxGarbageCollectResult {
  const blind = sweeps.find((sweep) => sweep.listingUnsupported)
  return {
    destroyed: sweeps.flatMap((sweep) => sweep.destroyed),
    kept: sweeps.flatMap((sweep) => sweep.kept),
    skipped: sweeps.flatMap((sweep) => sweep.skipped),
    failed: sweeps.flatMap((sweep) => sweep.failed),
    ...(blind ? { listingUnsupported: true as const, ...(blind.driver ? { driver: blind.driver } : {}) } : {}),
    ...(unreachable.length ? { unreachable } : {}),
  }
}
