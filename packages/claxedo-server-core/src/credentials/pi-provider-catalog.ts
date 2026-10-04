import { PI_LAUNCH_PROVIDERS, piRegistryCredentialProvider } from "./pi-credentials"
import { projectPiProviderCatalog } from "./pi-provider-projection"

/** The Pi providers this person has an account for. */
export function piProviderCatalog(owner: string, org?: string) {
  return projectPiProviderCatalog(new Map(PI_LAUNCH_PROVIDERS.flatMap((id) => {
    const by = piRegistryCredentialProvider(id, owner, org)
    return by === undefined ? [] : [[id, by] as const]
  })))
}
