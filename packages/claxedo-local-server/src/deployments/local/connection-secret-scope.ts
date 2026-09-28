import type { MachineLoginPolicy, TurnActor } from "@claxedo/harness/contract"
import { sessionAccountOwner } from "@claxedo/harness/registry"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"
import { credentialAdmitted } from "@claxedo/server-core/credentials/account-holder"
import { localMachineOwnerUserId } from "../../workspace/host-provider-config"

/**
 * This process is the machine's own desktop: whoever reaches it over loopback
 * is the machine owner and may spend its logins. Who that owner is as a
 * person comes with the credential snapshot, which names the enrolled owner
 * once the machine serves, so their relayed requests are the owner's too.
 */
export const DESKTOP_PLACEMENT: MachineLoginPolicy = { placement: "desktop", machineOwnerUserId: "", canUseOwnLogin: true }

export type LocalConnectionSecretScope = {
  /** Whether a connection with no stored secret may run on the machine's own login for this session. */
  machineLoginAllowed: boolean
  admits: (credential: Pick<CredentialMetadata, "owner">) => boolean
}

/**
 * Which stored credentials a session's connection may spend on this desktop:
 * its owner's own rows and the org's own (owner NULL) rows, never another
 * person's. Rows the unsigned loopback operator stored are the machine owner's.
 */
export function localConnectionSecretScope(owner: TurnActor): LocalConnectionSecretScope {
  const machineOwnerUserId = localMachineOwnerUserId()
  const account = sessionAccountOwner({ ...DESKTOP_PLACEMENT, machineOwnerUserId }, owner)
  return {
    machineLoginAllowed: account.machineLoginAllowed,
    admits: (credential) => credentialAdmitted(credential.owner, account.userId, machineOwnerUserId),
  }
}
