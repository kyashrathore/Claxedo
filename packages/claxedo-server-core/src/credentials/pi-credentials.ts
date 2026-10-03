import { credentialByProvider } from "@claxedo/server-core/credentials/registry"
import { PROVIDER_AUTH_KINDS } from "@claxedo/server-core/credentials/account-kinds"
import { spentRowOwner } from "./account-holder"
import { accountSelections } from "./account-source"
import { piCredentialConnected, piCredentialProviderIDs } from "./pi-provider-projection"
export { PI_LAUNCH_PROVIDERS, piCredentialProviderIDs } from "./pi-provider-projection"

export function piRegistryCredentialProvider(providerID: string, owner: string, org?: string) {
  const sources = accountSelections(org)[owner] ?? {}
  return piCredentialProviderIDs(providerID).find((id) => piCredentialConnected(providerID,
    credentialByProvider(id, { onOutage: "throw", kind: PROVIDER_AUTH_KINDS, owner: spentRowOwner(sources, id, owner) }, org)))
}
