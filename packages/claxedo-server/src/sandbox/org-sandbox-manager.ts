import type { SandboxDriver, SandboxGarbageCollectResult, SandboxLeaseStore, SandboxManager } from "@claxedo/sandbox-manager"
import type { SandboxKeyedDriver } from "../authority/services"
import { OPERATOR_SANDBOX_KEY, type OrgSandboxDrivers, type SandboxKeyBinding } from "./org-sandbox-drivers"

export const SANDBOX_KEY_LABEL = "sandboxKey"
export const SANDBOX_ORG_LABEL = "sandboxOrg"

/** Whose provider account a recorded `sandboxKey` label spends, without naming the key. */
export function sandboxKeyOwner(key: string | undefined): SandboxKeyedDriver["key"] {
  return key && key !== OPERATOR_SANDBOX_KEY ? "org" : "operator"
}

/**
 * One `SandboxManager` over every key a deployment spends. A workspace's first
 * ensure binds it to its organization's driver of the moment, and the lease's
 * labels record that key, so every later stop, snapshot or destroy reaches the
 * provider account that made the machine even after the organization adds or
 * switches keys. Lease-only operations need no driver and go to the operator's
 * manager, which shares the one lease store. A sweep visits the operator's
 * account and every organization key a lease names, each through its own
 * driver; one organization's revoked or removed key cannot stop the others'.
 */
export function createOrgSandboxManager(input: {
  leaseStore: SandboxLeaseStore
  drivers: OrgSandboxDrivers
  workspaceOrg: (workspaceId: string) => Promise<string | undefined>
  manager: (driver: SandboxDriver) => SandboxManager
}) {
  const operator = input.manager(input.drivers.operator.driver)
  const managers = new WeakMap<SandboxKeyBinding, SandboxManager>()
  const managerFor = (binding: SandboxKeyBinding) => {
    if (binding.key === OPERATOR_SANDBOX_KEY) return operator
    const manager = managers.get(binding) ?? input.manager(binding.driver)
    managers.set(binding, manager)
    return manager
  }
  const bound = async (workspaceId: string, fresh: boolean): Promise<{ binding: SandboxKeyBinding; orgId?: string }> => {
    const lease = await input.leaseStore.get(workspaceId)
    const labels = lease && lease.status !== "destroyed" ? lease.labels : undefined
    const key = labels?.[SANDBOX_KEY_LABEL]
    const recordedOrg = labels?.[SANDBOX_ORG_LABEL]
    if (key && key !== OPERATOR_SANDBOX_KEY && recordedOrg) {
      return { binding: await input.drivers.forKey(recordedOrg, key), orgId: recordedOrg }
    }
    if (key || !fresh) return { binding: input.drivers.operator, ...(recordedOrg ? { orgId: recordedOrg } : {}) }
    const orgId = await input.workspaceOrg(workspaceId)
    if (!orgId) throw new Error(`workspace ${workspaceId} has no active owner to choose a sandbox provider for`)
    return { binding: await input.drivers.forOrg(orgId), orgId }
  }
  const routed = async (workspaceId: string) => managerFor((await bound(workspaceId, false)).binding)
  const manager: SandboxManager = {
    ensure: async (workspaceId, managerInput) => {
      const { binding, orgId } = await bound(workspaceId, true)
      const labels = { ...managerInput.labels, [SANDBOX_KEY_LABEL]: binding.key, ...(orgId ? { [SANDBOX_ORG_LABEL]: orgId } : {}) }
      return await managerFor(binding).ensure(workspaceId, { ...managerInput, labels })
    },
    register: (workspaceId, snapshot) => operator.register(workspaceId, snapshot),
    heartbeat: (workspaceId, snapshot) => operator.heartbeat(workspaceId, snapshot),
    target: (workspaceId) => operator.target(workspaceId),
    release: (workspaceId) => operator.release(workspaceId),
    touch: async (workspaceId) => (await routed(workspaceId)).touch(workspaceId),
    snapshot: async (workspaceId, committed) => (await routed(workspaceId)).snapshot(workspaceId, committed),
    checkpoint: async (workspaceId, request) => (await routed(workspaceId)).checkpoint(workspaceId, request),
    restore: async (workspaceId, request) => (await routed(workspaceId)).restore(workspaceId, request),
    stop: async (workspaceId, request) => (await routed(workspaceId)).stop(workspaceId, request),
    destroy: async (workspaceId) => (await routed(workspaceId)).destroy(workspaceId),
    recordStartPhases: async (workspaceId, phases) => (await routed(workspaceId)).recordStartPhases(workspaceId, phases),
    markStartPhase: async (workspaceId, phase) => (await routed(workspaceId)).markStartPhase(workspaceId, phase),
    garbageCollect: async () => {
      const sweeps = [await operator.garbageCollect()]
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
    list: () => operator.list(),
  }
  const keyedDriver = (binding: SandboxKeyBinding): SandboxKeyedDriver => ({ driver: binding.driver, key: sandboxKeyOwner(binding.key) })
  return {
    manager,
    workspaceDriver: async (workspaceId: string) => keyedDriver((await bound(workspaceId, true)).binding),
    orgDriver: async (orgId: string) => keyedDriver(await input.drivers.forOrg(orgId)),
  }
}

async function leasedOrgKeys(leaseStore: SandboxLeaseStore) {
  const keys = new Map<string, { key: string; orgId: string; driver: string }>()
  for (const lease of await leaseStore.list()) {
    const key = lease.labels?.[SANDBOX_KEY_LABEL]
    const orgId = lease.labels?.[SANDBOX_ORG_LABEL]
    if (key && key !== OPERATOR_SANDBOX_KEY && orgId && !keys.has(key)) keys.set(key, { key, orgId, driver: lease.driver })
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
