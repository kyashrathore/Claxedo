import {
  HARNESS_TABLE,
  isProviderUnavailable,
  PI_LAUNCH_PROVIDERS,
  piCredentialProviderIDs,
  type ProviderDirect,
  type ProviderProjectionSource,
} from "@claxedo/agent-runtime-contract"
import type { ProviderDestination } from "@claxedo/server-core/credentials/destinations"
import { isSubscriptionKind } from "@claxedo/server-core/credentials/secret-material"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"

/**
 * The stored providers whose harnesses call the vendor in process: Pi, which
 * has no egress broker in front of it, and Codex, whose subscription login
 * reads the account from the token itself.
 */
const DIRECT_PROVIDER_IDS = new Set([...PI_LAUNCH_PROVIDERS.flatMap(piCredentialProviderIDs), ...HARNESS_TABLE.codex.providerIds])

export type BoundRow = { credential: CredentialMetadata; destination: ProviderDestination }

/** The machine owner's selected Pi and Codex accounts, as the credential itself. */
export function machineOwnerDirectRows(selected: Record<string, ProviderProjectionSource> | undefined, bound: readonly BoundRow[]): Record<string, ProviderDirect> {
  return Object.fromEntries(Object.entries(selected ?? {}).flatMap(([providerId, projection]): [string, ProviderDirect][] => {
    if (!DIRECT_PROVIDER_IDS.has(providerId) || isProviderUnavailable(projection) || !projection.account) return []
    const account = projection.account
    const row = bound.find((entry) => entry.credential.id === account.credentialId)
    if (!row) return []
    const { destination, credential } = row
    return [[providerId, {
      delivery: "direct", baseUrl: destination.origin, ...(destination.apiPath ? { apiPath: destination.apiPath } : {}),
      secret: destination.value, authKind: isSubscriptionKind(credential.kind) ? "subscription" : "api-key",
      ...(credential.expires_at ? { expiresAt: credential.expires_at } : {}), account,
    }]]
  }))
}
