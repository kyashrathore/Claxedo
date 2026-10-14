import { credentialByProvider } from "@claxedo/server-core/credentials/registry"
import { PROVIDER_AUTH_KINDS } from "@claxedo/server-core/credentials/account-kinds"
import { spentRowOwner } from "./account-holder"
import { accountSelections } from "./account-source"
import { piProviderAccountAmong, type PiProviderAccount } from "./pi-provider-projection"
export { PI_LAUNCH_PROVIDERS, piCredentialProviderIDs } from "./pi-provider-projection"

export function piRegistryCredentialAccount(providerID: string, owner: string, org?: string): PiProviderAccount | undefined {
  const sources = accountSelections(org)[owner] ?? {}
  return piProviderAccountAmong(providerID, (id) =>
    credentialByProvider(id, { onOutage: "throw", kind: PROVIDER_AUTH_KINDS, owner: spentRowOwner(sources, id, owner) }, org))
}
