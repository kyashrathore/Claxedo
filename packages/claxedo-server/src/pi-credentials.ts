import { requireCredentialRegistryLookup } from "./credentials/registry"

export const PI_LAUNCH_PROVIDERS = ["openai-codex", "anthropic", "openai"] as const

const credentialProviders: Record<(typeof PI_LAUNCH_PROVIDERS)[number], readonly string[]> = {
  "openai-codex": ["codex-app-server", "codex-acp"],
  anthropic: ["anthropic"],
  openai: ["openai"],
}

export function piCredentialProviderIDs(providerID: string): readonly string[] {
  return providerID in credentialProviders
    ? credentialProviders[providerID as keyof typeof credentialProviders]
    : []
}

export function piRegistryCredentialProvider(providerID: string) {
  return piCredentialProviderIDs(providerID).find((id) => {
    const credential = requireCredentialRegistryLookup(id)
    if (credential?.status !== "available") return false
    return providerID === "openai-codex" ? credential.kind === "oauth_token" : credential.kind === "api_key"
  })
}

export function piRegistryProviderConnected(providerID: string) {
  return piRegistryCredentialProvider(providerID) !== undefined
}
