import { createProvider, type Model, type Provider, type ProviderAuth } from "@earendil-works/pi-ai"
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy"
import type { CustomProviderDefinition } from "../../contract"

const CONTEXT_WINDOW = 128_000
const MAX_TOKENS = 16_384

function definitionModel(definition: CustomProviderDefinition, id: string, name: string): Model<"openai-completions"> {
  return {
    id, name, api: "openai-completions", provider: definition.id, baseUrl: definition.baseURL, headers: { ...definition.headers },
    input: ["text"], reasoning: false, contextWindow: CONTEXT_WINDOW, maxTokens: MAX_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

export function customPiProvider(definition: CustomProviderDefinition, auth: ProviderAuth): Provider {
  return createProvider({
    id: definition.id, name: definition.name, baseUrl: definition.baseURL, auth, api: openAICompletionsApi(),
    models: Object.entries(definition.models).map(([id, model]) => definitionModel(definition, id, model.name)),
  })
}
