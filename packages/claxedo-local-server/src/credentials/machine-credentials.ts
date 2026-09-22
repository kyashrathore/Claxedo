import { defaultControlPlaneCredentials } from "@claxedo/server-core/authority/default-credentials"
import { readMachineLogins } from "@claxedo/server-core/credentials/machine-login"
import { clearActiveCredentials } from "@claxedo/server-core/credentials/registry"
import { syncCredentialsToSdk } from "@claxedo/server-core/opencode/sdk-credential-bridge"
import { workspaceSupervisor } from "@claxedo/server-core/workspace/supervisor-port"
import type { ControlPlaneCredentials } from "@claxedo/server-core/authority/control-plane-contract"

/**
 * The credential port for a server running on the machine the harnesses live on.
 *
 * Two of the contract's operations only mean something here. `machineLogins`
 * asks the CLIs installed beside this process what they are signed in as, and
 * `clearActiveCredentials` is how the operator says "run on that login instead
 * of a stored account" — a sentence with no referent on a box where no harness
 * is installed and the caller is one tenant of many. The shared default leaves
 * both off, and the routes answer 501, which is the honest answer there.
 */
export function localControlPlaneCredentials(): ControlPlaneCredentials {
  return {
    ...defaultControlPlaneCredentials(),
    machineLogins: (harnesses, options) => readMachineLogins(harnesses, { fresh: options?.fresh === true }),
    clearActiveCredentials: async (providerIds, org) => {
      const result = clearActiveCredentials(providerIds, org)
      // The engine resolves auth from a store Claxedo does not otherwise write:
      // without this the next embedded turn still runs on the account just
      // withdrawn. Running sandboxes hold the same accounts at their provider
      // edge, which only the supervisor's reconcile withdraws.
      if (result.cleared.length > 0) {
        await syncCredentialsToSdk(org, providerIds)
        await workspaceSupervisor().reconcileCredentialDelivery()
      }
      return result
    },
  }
}
