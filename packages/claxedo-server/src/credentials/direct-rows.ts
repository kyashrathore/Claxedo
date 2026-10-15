import { ORG_ACCOUNT_UNAVAILABLE, PI_LAUNCH_PROVIDERS, piCredentialProviderIDs, type ProviderDirect, type ProviderUnavailable } from "@claxedo/agent-runtime-contract"
import { holderAccountSources } from "@claxedo/server-core/credentials/account-holder"
import { builtInProviderRow } from "@claxedo/server-core/credentials/built-in-destinations"
import { credentialUnavailableReason } from "@claxedo/server-core/credentials/health"
import { directProviderDeliveriesFromRepository } from "@claxedo/server-core/credentials/native-delivery-plan"
import type { ControlPlaneCredentials } from "../authority/services"
import { storeRenewal } from "./store-renewal"

/** The stored providers an in-process Pi spends. */
export const PI_DIRECT_PROVIDERS: ReadonlySet<string> = new Set(PI_LAUNCH_PROVIDERS.flatMap(piCredentialProviderIDs))

/**
 * The accounts one person spends among `providers`, as the secrets
 * themselves, by stored provider id, each plan login renewed first when it is
 * due or its holder reports the token expiring at `rejectedExpiresAt`
 * refused. An account that cannot be handed over this time, unreadable or
 * refused, is left out: its provider runs without a credential and the others
 * are unaffected. `refused` names each provider the person chose the
 * organization's account for while the organization holds none.
 */
export async function ownerDirectDelivery(
  credentials: ControlPlaneCredentials,
  owner: string,
  input: { providers: ReadonlySet<string>; rejectedExpiresAt?: number },
): Promise<{ direct: Record<string, ProviderDirect>; refused: Record<string, ProviderUnavailable> }> {
  const selected = (await credentials.listCredentials())
    .filter((credential) => input.providers.has(credential.provider_id) && !!builtInProviderRow(credential.provider_id)
      && (credential.kind === "api_key" || credential.kind === "oauth_token"))
    .map((credential) => {
      const unavailable = credentialUnavailableReason(credential)
      return { credential, ...(unavailable ? { unavailable } : {}) }
    })
  const selections = await credentials.accountSelections()
  const renew = storeRenewal(credentials)
  const rows = await directProviderDeliveriesFromRepository({
    owner,
    machineOwnerUserId: owner,
    selections,
    selected,
    readSecret: (credential) => credentials.resolveCredentialSecretById?.(credential.id) ?? Promise.resolve(null),
    renew: (credential) => renew(credential, input.rejectedExpiresAt),
  })
  const orgHeld = new Set(selected.flatMap(({ credential }) => credential.owner === null ? [credential.provider_id] : []))
  const refused = Object.entries(holderAccountSources(selections, owner, owner)).flatMap(([providerId, source]) =>
    source === "org" && input.providers.has(providerId) && !orgHeld.has(providerId)
      ? [[providerId, { unavailable: true as const, reason: ORG_ACCOUNT_UNAVAILABLE }] as const]
      : [])
  return {
    direct: Object.fromEntries(rows.flatMap((row) => row.direct ? [[row.providerId, row.direct]] : [])),
    refused: Object.fromEntries(refused),
  }
}

/** The secrets of `ownerDirectDelivery` alone. */
export async function ownerDirectRows(
  credentials: ControlPlaneCredentials,
  owner: string,
  input: { providers: ReadonlySet<string>; rejectedExpiresAt?: number },
): Promise<Record<string, ProviderDirect>> {
  return (await ownerDirectDelivery(credentials, owner, input)).direct
}
