import type { AccountScope } from "@claxedo/account-contract/vocabulary"
import type { CredentialSnapshot } from "@claxedo/agent-runtime-contract"
import { Log } from "../platform/runtime/lib/log"
import {
  providerDestination,
} from "./destinations"
import {
  readSecretById,
  activeCredentialsForScope,
  type CredentialOrgScope,
} from "./registry"
import { SINGLE_TENANT_ORG } from "./partition"
import type { SandboxSecretBrokering } from "@claxedo/sandbox-contract"
import type { AccountSelections } from "./account-holder"
import { accountSelections } from "./account-source"

import { nativeProviderDeliveriesFromRepository, nativeProviderAuth } from "./native-delivery-plan"
import type { NativeProviderDelivery } from "./native-delivery-plan"
export {
  nativeProviderAuth,
  nativeProviderSecrets,
  nativeDeliveryDigest,
  nativeDeliveryDigestEntries,
  unreadableDeliveries,
} from "./native-delivery-plan"
export type {
  NativeProviderDelivery,
  NativeProviderSecret,
  SandboxSecretBrokering,
} from "./native-delivery-plan"

const log = Log.create({ service: "native-delivery" })

export async function nativeProviderDeliveries(input: {
  owner: string
  machineOwnerUserId: string
  selections: AccountSelections
  org?: CredentialOrgScope
  secretBrokering?: SandboxSecretBrokering
}): Promise<NativeProviderDelivery[]> {
  const org = input.org ?? SINGLE_TENANT_ORG
  return nativeProviderDeliveriesFromRepository({
    owner: input.owner,
    machineOwnerUserId: input.machineOwnerUserId,
    selections: input.selections,
    selected: activeCredentialsForScope("shared", { onOutage: "throw" }, org),
    readSecret: (credential) => readSecretById(credential.id, org),
    destination: ({ providerId, kind, secret }) => providerDestination({ providerId, kind, secret }),
    secretBrokering: input.secretBrokering,
    secretReadFailure: (credential, error) => log.warn("Credential secret could not be read for native delivery", {
      providerId: credential.provider_id,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }),
  })
}

/**
 * The credential authority for a runtime this process cannot serve: a sandbox
 * whose requests never traverse this machine's loopback, so the credential
 * travels through its own provider's edge.
 *
 * Installed wherever a composition provisions cloud sandboxes, with or without
 * a loopback broker beside it. A composition that answers shared scope with
 * nothing sends the harness no projection at all, and the harness reads that as
 * permission to run on whatever login its image carries.
 */
export async function projectNativeProviderAuth(input: {
  scope?: AccountScope
  /** The person the sandbox serves; only the accounts they chose reach it. */
  sandboxOwner?: string
  machineOwnerUserId: string
  orgId?: CredentialOrgScope
  secretBrokering?: SandboxSecretBrokering
}): Promise<CredentialSnapshot> {
  if (input.scope !== "shared") return { machineOwnerUserId: input.machineOwnerUserId, accounts: {} }
  if (!input.sandboxOwner) throw new Error("a shared-scope projection needs the person its sandbox serves")
  const selections = accountSelections(input.orgId)
  return nativeProviderAuth(await nativeProviderDeliveries({
    owner: input.sandboxOwner,
    machineOwnerUserId: input.machineOwnerUserId,
    selections,
    ...(input.orgId ? { org: input.orgId } : {}),
    ...(input.secretBrokering ? { secretBrokering: input.secretBrokering } : {}),
  }), { owner: input.sandboxOwner, machineOwnerUserId: input.machineOwnerUserId, selections })
}
