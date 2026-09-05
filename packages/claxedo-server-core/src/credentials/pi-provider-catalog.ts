import { localPiCredentialProviders } from "@claxedo/agent-sdk-runtime/adapters"
import { PI_LAUNCH_PROVIDERS, piRegistryProviderConnected } from "./pi-credentials"
import { projectPiProviderCatalog } from "./pi-provider-projection"

export type PiPromptModel = { providerID: string; modelID: string }

export function piProviderCatalog(env: NodeJS.ProcessEnv = process.env, org?: string) {
  const enabled = env.CLAXEDO_PI_MODEL_BACKEND === "1" || !!env.CLAXEDO_PI_MODEL?.trim()
  const local = enabled ? new Set(localPiCredentialProviders()) : new Set<string>()
  const connected = new Set(PI_LAUNCH_PROVIDERS.filter((id) => piRegistryProviderConnected(id, org)))
  return projectPiProviderCatalog(connected, local)
}

export function validatePiPromptModel(model: PiPromptModel, env: NodeJS.ProcessEnv = process.env) {
  const catalog = piProviderCatalog(env)
  const provider = catalog.all.find((item) => item.id === model.providerID)
  if (!provider || !(model.modelID in provider.models)) {
    return { code: "pi_model_unsupported", message: `Pi does not support model ${model.providerID}/${model.modelID}` }
  }
  if (!catalog.connected.includes(model.providerID)) {
    return { code: "pi_model_credentials_missing", message: `Connect ${model.providerID} before selecting this Pi model` }
  }
}
