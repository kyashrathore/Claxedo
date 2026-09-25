import type { ProviderProjectionSource } from "@claxedo/agent-runtime-contract"
import { Log } from "../platform/runtime/lib/log"
import {
  providerDestination,
  providerDestinationShape,
} from "./destinations"
import {
  readSecretById,
  activeCredentialsForScope,
  SINGLE_TENANT_ORG,
  type CredentialOrgScope,
} from "./registry"
import type { SandboxSecretBrokering } from "@claxedo/sandbox-contract"
import type { CredentialKind } from "./types"

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

/**
 * Where an account can actually be spent.
 *
 * `local` is always true: the loopback broker holds the value in this process
 * and every stored account reaches it. `cloud` is the narrower question, and it
 * is answered here rather than inferred from "we have it stored", because a
 * provider edge attaches one header per secret and a destination that also
 * needs a fixed companion header cannot be delivered through one at all.
 */
export type CredentialReach = { local: true; cloud: boolean; reason?: string }

export function credentialReach(row: { provider_id: string; kind: CredentialKind }): CredentialReach {
  const destination = providerDestinationShape({ providerId: row.provider_id, kind: row.kind })
  if (!destination) return { local: true, cloud: false, reason: "no_destination" }
  if (destination.injection.headers) {
    return { local: true, cloud: false, reason: "native_delivery_needs_companion_header" }
  }
  if (destination.exchange) return { local: true, cloud: false, reason: "native_delivery_needs_token_exchange" }
  return { local: true, cloud: true }
}

const log = Log.create({ service: "native-delivery" })

export async function nativeProviderDeliveries(input: {
  org?: CredentialOrgScope
  secretBrokering?: SandboxSecretBrokering
} = {}): Promise<NativeProviderDelivery[]> {
  const org = input.org ?? SINGLE_TENANT_ORG
  return nativeProviderDeliveriesFromRepository({
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
  scope: "local" | "shared"
  orgId?: CredentialOrgScope
  secretBrokering?: SandboxSecretBrokering
}): Promise<Record<string, ProviderProjectionSource>> {
  if (input.scope !== "shared") return {}
  return nativeProviderAuth(await nativeProviderDeliveries({
    ...(input.orgId ? { org: input.orgId } : {}),
    ...(input.secretBrokering ? { secretBrokering: input.secretBrokering } : {}),
  }))
}
