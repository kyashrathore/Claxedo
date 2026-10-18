import { ORG_ACCOUNT_UNAVAILABLE, PI_LAUNCH_PROVIDERS, piCredentialProviderIDs, type ProviderDirect, type ProviderUnavailable } from "@claxedo/agent-runtime-contract"
import { holderAccountSources, type AccountSelections } from "@claxedo/server-core/credentials/account-holder"
import { builtInProviderRow } from "@claxedo/server-core/credentials/built-in-destinations"
import { credentialUnavailableReason } from "@claxedo/server-core/credentials/health"
import { directProviderDeliveriesFromRepository, type NativeCredentialSelection } from "@claxedo/server-core/credentials/native-delivery-plan"
import type { ControlPlaneCredentials } from "../authority/services"
import type { SealedCredentialSecret } from "@claxedo/server-core/authority/control-plane-contract"
import { storeRenewal } from "./store-renewal"

/** The stored providers an in-process Pi spends. */
export const PI_DIRECT_PROVIDERS: ReadonlySet<string> = new Set(PI_LAUNCH_PROVIDERS.flatMap(piCredentialProviderIDs))

/** The rows that name a person's accounts among `providers`, with their secrets still sealed. */
export type SelectedDirectAccounts = {
  selected: readonly NativeCredentialSelection[]
  selections: AccountSelections
  sealed: ReadonlyMap<string, SealedCredentialSecret>
}

/**
 * Which stored rows a person spends among `providers`, the organization's
 * account selections, and those rows' secrets as stored, still sealed: no
 * secret is opened, so this can run before anything has decided the caller
 * may have the accounts.
 */
export async function selectDirectAccounts(credentials: ControlPlaneCredentials, providers: ReadonlySet<string>): Promise<SelectedDirectAccounts> {
  const [listed, selections] = await Promise.all([credentials.listCredentials(), credentials.accountSelections()])
  const selected = listed
    .filter((credential) => providers.has(credential.provider_id) && !!builtInProviderRow(credential.provider_id)
      && (credential.kind === "api_key" || credential.kind === "oauth_token"))
    .map((credential) => {
      const unavailable = credentialUnavailableReason(credential)
      return { credential, ...(unavailable ? { unavailable } : {}) }
    })
  const sealed = new Map<string, SealedCredentialSecret>()
  if (credentials.sealedCredentialSecret) {
    for (const row of await Promise.all(selected.map(({ credential }) => credentials.sealedCredentialSecret!(credential.id)))) {
      if (row) sealed.set(row.credentialId, row)
    }
  }
  return { selected, selections, sealed }
}

/**
 * The accounts one person spends among `providers`, as the secrets
 * themselves, by stored provider id, each plan login renewed first when it is
 * due or its holder reports the token expiring at `rejectedExpiresAt`
 * refused. An account that cannot be handed over this time, unreadable or
 * refused, is left out of `direct`: its provider runs without a credential and
 * the others are unaffected. `refused` says why a provider the person chose an
 * account for has none this time, that account's refusal or an organization
 * that holds no organization account for it, so a turn names the reason rather than
 * reading as no account chosen. This is where a secret is opened, from the
 * sealed row read earlier when the row is at that revision still, and from
 * the store again when a renewal rewrote it: nothing before it reads one.
 */
export async function openDirectAccounts(
  credentials: ControlPlaneCredentials,
  owner: string,
  accounts: SelectedDirectAccounts,
  input: { providers: ReadonlySet<string>; rejectedExpiresAt?: number },
): Promise<{ direct: Record<string, ProviderDirect>; refused: Record<string, ProviderUnavailable> }> {
  const { selected, selections } = accounts
  const renew = storeRenewal(credentials)
  const rows = await directProviderDeliveriesFromRepository({
    owner,
    machineOwnerUserId: owner,
    selections,
    selected,
    readSecret: (credential) => {
      const sealed = accounts.sealed.get(credential.id)
      return sealed && sealed.revision === credential.revision && credentials.openSealedCredentialSecret
        ? credentials.openSealedCredentialSecret(sealed)
        : credentials.resolveCredentialSecretById?.(credential.id) ?? Promise.resolve(null)
    },
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

/** `selectDirectAccounts` then `openDirectAccounts`, for a caller already entitled to the accounts. */
export async function ownerDirectDelivery(
  credentials: ControlPlaneCredentials,
  owner: string,
  input: { providers: ReadonlySet<string>; rejectedExpiresAt?: number },
) {
  return openDirectAccounts(credentials, owner, await selectDirectAccounts(credentials, input.providers), input)
}
