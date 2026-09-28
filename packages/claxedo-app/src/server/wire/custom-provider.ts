import type { CustomProviderConfig } from "../provider-connect"

export function customProviderBody(config: CustomProviderConfig) {
  return { providerID: config.providerId, name: config.name, baseURL: config.baseURL, env: config.env, headers: config.headers, credentialHeader: config.credentialHeader, models: config.models }
}
