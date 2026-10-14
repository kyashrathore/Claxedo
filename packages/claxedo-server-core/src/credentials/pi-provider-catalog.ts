import { PI_LAUNCH_PROVIDERS, piRegistryCredentialAccount } from "./pi-credentials"
import { projectPiProviderCatalog } from "./pi-provider-projection"

/** The Pi providers this person has an account for, usable or refused. */
export function piProviderCatalog(owner: string, org?: string) {
  return projectPiProviderCatalog(new Map(PI_LAUNCH_PROVIDERS.flatMap((id) => {
    const account = piRegistryCredentialAccount(id, owner, org)
    return account === undefined ? [] : [[id, account] as const]
  })))
}
