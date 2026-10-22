import { accountsRenewalDueAt } from "@claxedo/agent-runtime-contract"
import { machineSealAad } from "@claxedo/account-contract/machine"
import { sealForMachine } from "@claxedo/account-contract/machine-seal"
import { serializeHostProviderConfig } from "@claxedo/server-core/credentials/host-provider-config"
import {
  deliverableRows,
  deliveredAccountsIdentity,
  nativeProviderAuth,
  nativeProviderDeliveriesFromRepository,
} from "@claxedo/server-core/credentials/native-delivery-plan"
import type {
  HostProviderConfigRevision,
  MachinePrincipal,
  MachineProviderConfigBuild,
  MachineProviderConfigState,
} from "@claxedo/server-core/platform/auth/host-connect-contract"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import type { ControlPlaneCredentials } from "../authority/services"
import type { HostChangedInput } from "../workspace/route-support"
import type { HostedEgressBroker } from "./hosted-egress-broker"
import { storeRenewal } from "./store-renewal"
import type { CredentialChange } from "./worker/org-routed"

const log = Log.create({ service: "machine-provider-config" })

/** How long a machine whose build failed waits before its beats try again, so a fault does not cost a build per beat. */
const BUILD_RETRY_MS = 60_000

/** What a build reads and writes of a `claxedo connect` machine's stored configuration (`D1HostProviderConfigAuthority`). */
export type MachineProviderConfigStore = {
  machineProviderConfigState(machine: MachinePrincipal): Promise<MachineProviderConfigState | undefined>
  storeMachineProviderConfig(machine: MachinePrincipal, build: MachineProviderConfigBuild): Promise<boolean>
  providerConfigMachines(orgId: string): Promise<Array<{ enrollmentId: string; ownerUserId: string; hostId: string; accounts: string | null }>>
  staleMachineProviderConfigAccounts(enrollmentIds: readonly string[]): Promise<void>
}

export type MachineProviderConfig = {
  /**
   * On a verified beat: builds, seals and stores the machine's configuration
   * when one is due, answering the revision the same beat delivers; nothing
   * when none is due, or for a machine its owner enrolled from an account.
   */
  beat(machine: MachinePrincipal): Promise<(HostProviderConfigRevision & { sealed: string }) | undefined>
  /** `change` with the organization's connected machines added: each one whose owner's accounts the write changed builds again and is rung. */
  credentialChange(change: CredentialChange, ring: (host: HostChangedInput) => Promise<void>): CredentialChange
}

/**
 * Whether a machine's next beat builds: never over an owner's push it has not
 * acked, nor for a machine with no sealing key or serving generation yet; and
 * otherwise when it holds no current build, a new instance of it serves, its
 * stand-ins are past half their life, or what it holds no longer opens.
 */
export function providerConfigBuildDue(state: MachineProviderConfigState, now: number): boolean {
  if (state.sealingPublicKey === null || state.servingGeneration < 1 || state.ownerPushPending) return false
  const built = state.built
  return !built || state.rekeyed || built.generation !== state.servingGeneration || (built.renewAt !== null && now >= built.renewAt)
}

/**
 * The provider configuration the control plane builds for every machine
 * enrolled with `claxedo connect`: the owner's stored accounts, each bound on
 * the plane's broker to a stand-in naming the machine's enrollment, sealed for
 * the machine's key. No key or plan token is in it; the broker injects the
 * account at each request and refuses the stand-in once the enrollment is
 * revoked, paused or superseded.
 *
 * Renewal rides the machine's own beat, so nothing is scheduled: a beat finds
 * a build due and the same answer delivers it.
 */
export function createMachineProviderConfig(input: {
  store: MachineProviderConfigStore
  credentials: (orgId: string) => ControlPlaneCredentials
  broker: Pick<HostedEgressBroker, "machineBinder">
  now?: () => number
}): MachineProviderConfig {
  const now = input.now ?? Date.now
  const failedAt = new Map<string, number>()
  const accountsOf = async (orgId: string) => {
    const credentials = input.credentials(orgId)
    const [rows, selections] = await Promise.all([credentials.listCredentials(), credentials.accountSelections()])
    return { credentials, selections, selected: deliverableRows(rows) }
  }
  const build = async (machine: MachinePrincipal, state: MachineProviderConfigState & { sealingPublicKey: string }, at: number) => {
    const owner = state.ownerUserId
    const { credentials, selections, selected } = await accountsOf(state.orgId)
    const walk = { owner, machineOwnerUserId: owner, selections, selected }
    const delivered = await nativeProviderDeliveriesFromRepository({
      ...walk,
      readSecret: (credential) => credentials.resolveCredentialSecretById?.(credential.id) ?? Promise.resolve(null),
      renew: storeRenewal(credentials),
      broker: input.broker.machineBinder({
        orgId: state.orgId,
        machine: { enrollmentId: state.enrollmentId, servingGeneration: state.servingGeneration, hostId: state.hostId },
      }),
      directPlans: false,
    })
    const snapshot = nativeProviderAuth(delivered, { owner, machineOwnerUserId: owner, selections })
    const providers = snapshot.accounts[owner] ?? {}
    const revision = state.nextRevision
    const sealed = await sealForMachine(
      state.sealingPublicKey,
      serializeHostProviderConfig(providers, owner, {}, "control-plane"),
      machineSealAad({ enrollmentId: state.enrollmentId, revision }),
    )
    const stored = await input.store.storeMachineProviderConfig(machine, {
      revision,
      sealed,
      sealingPublicKey: state.sealingPublicKey,
      providerIds: Object.keys(providers).sort(),
      generation: state.servingGeneration,
      renewAt: accountsRenewalDueAt(snapshot, at) ?? null,
      accounts: await deliveredAccountsIdentity(walk),
    })
    return stored ? { revision, sealed } : undefined
  }
  const accountsChanged = async (orgId: string) => {
    const machines = await input.store.providerConfigMachines(orgId)
    if (machines.length === 0) return []
    const { selections, selected } = await accountsOf(orgId)
    const changed: typeof machines = []
    for (const machine of machines) {
      const owner = machine.ownerUserId
      if (await deliveredAccountsIdentity({ owner, machineOwnerUserId: owner, selections, selected }) !== machine.accounts) changed.push(machine)
    }
    await input.store.staleMachineProviderConfigAccounts(changed.map((machine) => machine.enrollmentId))
    return changed
  }
  return {
    async beat(machine) {
      const at = now()
      const failed = failedAt.get(machine.enrollmentId)
      if (failed !== undefined && at - failed < BUILD_RETRY_MS) return undefined
      try {
        const state = await input.store.machineProviderConfigState(machine)
        const sealingPublicKey = state?.sealingPublicKey
        if (!state || !sealingPublicKey || !providerConfigBuildDue(state, at)) return undefined
        const built = await build(machine, { ...state, sealingPublicKey }, at)
        failedAt.delete(machine.enrollmentId)
        return built
      } catch (error) {
        failedAt.set(machine.enrollmentId, at)
        log.warn("a connected machine's provider configuration was not built; it keeps what it holds", {
          enrollmentId: machine.enrollmentId,
          error: String(error),
        })
        return undefined
      }
    },
    credentialChange: (change, ring) => async (orgId) => {
      const settle = await change(orgId)
      return async () => {
        await settle()
        // The write is done; a machine this fails to mark keeps its build until its stand-ins renew.
        try {
          for (const machine of await accountsChanged(orgId)) await ring({ ownerUserId: machine.ownerUserId, hostId: machine.hostId })
        } catch (error) {
          log.warn("connected machines were not told the organization's accounts changed", { orgId, error: String(error) })
        }
      }
    },
  }
}
