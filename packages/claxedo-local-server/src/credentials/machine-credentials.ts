import { defaultControlPlaneCredentials, deliverCredentialChange } from "@claxedo/server-core/authority/default-credentials"
import { readMachineLogins } from "@claxedo/server-core/credentials/machine-login"
import { clearActiveCredentials } from "@claxedo/server-core/credentials/registry"
import { syncEmbeddedWorkspaceRuntimes } from "../deployments/local/embedded-workspace-runtime"
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
    ...defaultControlPlaneCredentials({ refreshLocalRuntimes: syncEmbeddedWorkspaceRuntimes }),
    machineLogins: (harnesses, options) => readMachineLogins(harnesses, { fresh: options?.fresh === true }),
    clearActiveCredentials: async (providerIds, org) => {
      const result = clearActiveCredentials(providerIds, org)
      if (result.cleared.length > 0) await deliverCredentialChange(syncEmbeddedWorkspaceRuntimes)
      return result
    },
  }
}
