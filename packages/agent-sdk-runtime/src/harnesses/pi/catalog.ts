import { getModels, getProviders } from "@mariozechner/pi-ai"

export type PiModelCatalogModel = {
  id: string
  name: string
  provider: string
  api: string
  reasoning: boolean
  input: Array<"text" | "image">
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  contextWindow: number
  maxTokens: number
}

export type PiModelCatalogProvider = {
  id: string
  models: PiModelCatalogModel[]
}

/** Serializable view of pi-ai's built-in provider/model registry. */
export function piModelCatalog(): PiModelCatalogProvider[] {
  return getProviders().map((provider) => ({
    id: provider,
    models: getModels(provider).map((model) => ({
      id: model.id,
      name: model.name,
      provider: model.provider,
      api: model.api,
      reasoning: model.reasoning,
      input: [...model.input],
      cost: { ...model.cost },
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  }))
}
