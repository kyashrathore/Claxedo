import { PI_LAUNCH_PROVIDERS, piRegistryProviderConnected } from "./pi-credentials"
import { projectPiProviderCatalog } from "./pi-provider-projection"

/** The Pi providers this person has an account for. */
export function piProviderCatalog(owner: string, org?: string) {
  return projectPiProviderCatalog(new Set(PI_LAUNCH_PROVIDERS.filter((id) => piRegistryProviderConnected(id, owner, org))))
}
