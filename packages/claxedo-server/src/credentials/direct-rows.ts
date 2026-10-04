import { PI_LAUNCH_PROVIDERS, piCredentialProviderIDs, type ProviderDirect } from "@claxedo/agent-runtime-contract"
import { builtInProviderRow } from "@claxedo/server-core/credentials/built-in-destinations"
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
 * are unaffected.
 */
export async function ownerDirectRows(
  credentials: ControlPlaneCredentials,
  owner: string,
  input: { providers: ReadonlySet<string>; rejectedExpiresAt?: number },
): Promise<Record<string, ProviderDirect>> {
  const selected = (await credentials.listCredentials())
    .filter((credential) => input.providers.has(credential.provider_id) && !!builtInProviderRow(credential.provider_id)
      && (credential.kind === "api_key" || credential.kind === "oauth_token"))
    .map((credential) => ({ credential, ...(credential.status !== "available" ? { unavailable: credential.status } : {}) }))
  const renew = storeRenewal(credentials)
  const rows = await directProviderDeliveriesFromRepository({
    owner,
    machineOwnerUserId: owner,
    selections: await credentials.accountSelections(),
    selected,
    readSecret: (credential) => credentials.resolveCredentialSecretById?.(credential.id) ?? Promise.resolve(null),
    renew: (credential) => renew(credential, input.rejectedExpiresAt),
  })
  return Object.fromEntries(rows.flatMap((row) => row.direct ? [[row.providerId, row.direct]] : []))
}
