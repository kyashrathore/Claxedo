import { requireCredentialRegistryLookup } from "@claxedo/server-core/credentials/registry"
import { piCredentialConnected, piCredentialProviderIDs } from "./pi-provider-projection"
export { PI_LAUNCH_PROVIDERS, piCredentialProviderIDs } from "./pi-provider-projection"

export function piRegistryCredentialProvider(providerID: string, org?: string) {
  return piCredentialProviderIDs(providerID).find((id) => {
    const credential = requireCredentialRegistryLookup(id, org)
    return piCredentialConnected(providerID, credential)
  })
}

export function piRegistryProviderConnected(providerID: string, org?: string) {
  return piRegistryCredentialProvider(providerID, org) !== undefined
}
