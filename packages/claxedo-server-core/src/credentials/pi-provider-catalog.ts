import { PI_LAUNCH_PROVIDERS, piRegistryProviderConnected } from "./pi-credentials"
import { projectPiProviderCatalog } from "./pi-provider-projection"

export function piProviderCatalog(_env: NodeJS.ProcessEnv = process.env, org?: string) {
  return projectPiProviderCatalog(new Set(PI_LAUNCH_PROVIDERS.filter((id) => piRegistryProviderConnected(id, org))))
}
