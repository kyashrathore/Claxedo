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
 * refused, is left out of `direct`: its provider runs without a credential and
 * the others are unaffected. `refused` says why a provider the person chose an
 * account for has none this time, that account's refusal or an organization
 * that holds no team key for it, so a turn names the reason rather than
 * reading as no account chosen.
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
  const direct: Record<string, ProviderDirect> = Object.fromEntries(rows.flatMap((row) => row.direct ? [[row.providerId, row.direct]] : []))
  const refused: Record<string, ProviderUnavailable> = Object.fromEntries(rows.flatMap((row) =>
    row.unavailable && !direct[row.providerId] ? [[row.providerId, { unavailable: true as const, reason: row.unavailable }]] : []))
  const orgHeld = new Set(selected.flatMap(({ credential }) => credential.owner === null ? [credential.provider_id] : []))
  for (const [providerId, source] of Object.entries(holderAccountSources(selections, owner, owner))) {
    if (source === "org" && input.providers.has(providerId) && !orgHeld.has(providerId)) {
      refused[providerId] = { unavailable: true, reason: ORG_ACCOUNT_UNAVAILABLE }
    }
  }
  return { direct, refused }
}
