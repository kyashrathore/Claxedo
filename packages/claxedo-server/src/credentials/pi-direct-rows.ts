import { PI_LAUNCH_PROVIDERS, piCredentialProviderIDs, type ProviderDirect } from "@claxedo/agent-runtime-contract"
import { builtInProviderRow } from "@claxedo/server-core/credentials/built-in-destinations"
import { directProviderDeliveriesFromRepository } from "@claxedo/server-core/credentials/native-delivery-plan"
import type { ControlPlaneCredentials } from "../authority/services"

const PI_STORED_PROVIDERS: ReadonlySet<string> = new Set(PI_LAUNCH_PROVIDERS.flatMap(piCredentialProviderIDs))

/**
 * The accounts one person's in-process Pi spends, as the secrets themselves,
 * by stored provider id. An account that cannot be handed over this time,
 * unreadable or refused, is left out: its provider runs without a credential
 * and the others are unaffected.
 */
export async function piDirectRows(credentials: ControlPlaneCredentials, owner: string): Promise<Record<string, ProviderDirect>> {
  const selected = (await credentials.listCredentials())
    .filter((credential) => PI_STORED_PROVIDERS.has(credential.provider_id) && !!builtInProviderRow(credential.provider_id)
      && (credential.kind === "api_key" || credential.kind === "oauth_token"))
    .map((credential) => ({ credential, ...(credential.status !== "available" ? { unavailable: credential.status } : {}) }))
  const rows = await directProviderDeliveriesFromRepository({
    owner,
    machineOwnerUserId: owner,
    selections: await credentials.accountSelections(),
    selected,
    readSecret: (credential) => credentials.resolveCredentialSecretById?.(credential.id) ?? Promise.resolve(null),
  })
  return Object.fromEntries(rows.flatMap((row) => row.direct ? [[row.providerId, row.direct]] : []))
}
