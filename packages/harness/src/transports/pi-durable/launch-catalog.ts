import { isPiLaunchProvider, type PiLaunchProvider } from "@claxedo/agent-runtime-contract"
import { getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel, type Provider } from "@earendil-works/pi-ai"
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import { googleProvider } from "@earendil-works/pi-ai/providers/google"
import { groqProvider } from "@earendil-works/pi-ai/providers/groq"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter"
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai"
import { configOptionsPreview, modelAndEffortOptions } from "../../contract"

export const PI_BUILT_IN_PROVIDERS: Record<PiLaunchProvider, () => Provider> = {
  "openai-codex": openaiCodexProvider, anthropic: anthropicProvider, openai: openaiProvider, openrouter: openrouterProvider,
  google: googleProvider, groq: groqProvider, xai: xaiProvider,
}

export type PiCatalogModel = { id: string; name: string; efforts: ModelThinkingLevel[] }

export function piCatalogModel(provider: string, model: Model<Api>): PiCatalogModel {
  return { id: `${provider}/${model.id}`, name: model.name || model.id, efforts: getSupportedThinkingLevels(model) }
}

export function piLaunchCatalog(providers: readonly string[]): PiCatalogModel[] {
  return providers.filter(isPiLaunchProvider).flatMap((provider) =>
    PI_BUILT_IN_PROVIDERS[provider]().getModels().map((model) => piCatalogModel(provider, model)))
}

export function piCatalogOptions(models: readonly PiCatalogModel[], selectedId?: string, effort?: string) {
  const model = models.find((row) => row.id === selectedId)
  return configOptionsPreview(modelAndEffortOptions({
    models: models.map(({ id, name }) => ({ id, name, connected: true as const })),
    ...(model ? { selected: model.id } : {}),
    efforts: model?.efforts ?? [],
    ...(effort ? { currentEffort: effort } : {}),
  }))
}
