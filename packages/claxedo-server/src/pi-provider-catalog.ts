import { localPiCredentialProviders, piModelCatalog } from "@claxedo/agent-sdk-runtime/adapters"
import { PI_LAUNCH_PROVIDERS, piRegistryProviderConnected } from "./pi-credentials"

export type PiPromptModel = { providerID: string; modelID: string }

const providerNames: Record<(typeof PI_LAUNCH_PROVIDERS)[number], string> = {
  "openai-codex": "OpenAI Codex",
  anthropic: "Anthropic",
  openai: "OpenAI",
}

function localCredentialProviders(env: NodeJS.ProcessEnv) {
  const enabled = env.CLAXEDO_PI_MODEL_BACKEND === "1" || !!env.CLAXEDO_PI_MODEL?.trim()
  return enabled ? new Set(localPiCredentialProviders()) : new Set<string>()
}

export function piProviderCatalog(env: NodeJS.ProcessEnv = process.env) {
  const launch = new Set<string>(PI_LAUNCH_PROVIDERS)
  const local = localCredentialProviders(env)
  const providers = piModelCatalog().filter((provider) => launch.has(provider.id))
  return {
    all: providers.map((provider) => ({
      id: provider.id,
      name: providerNames[provider.id as keyof typeof providerNames] ?? provider.id,
      env: [],
      source: piRegistryProviderConnected(provider.id) ? "config" : local.has(provider.id) ? "env" : "config",
      models: Object.fromEntries(provider.models.map((model) => [model.id, {
        id: model.id,
        name: model.name,
        attachment: model.input.includes("image"),
        reasoning: model.reasoning,
        temperature: true,
        tool_call: true,
        limit: { context: model.contextWindow, output: model.maxTokens },
        cost: {
          input: model.cost.input,
          output: model.cost.output,
          cache_read: model.cost.cacheRead,
          cache_write: model.cost.cacheWrite,
        },
        options: {},
      }])),
    })),
    connected: providers
      .filter((provider) => piRegistryProviderConnected(provider.id) || local.has(provider.id))
      .map((provider) => provider.id),
    default: Object.fromEntries(providers.flatMap((provider) => provider.models[0]
      ? [[provider.id, provider.models[0].id] as const]
      : [])),
  }
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
