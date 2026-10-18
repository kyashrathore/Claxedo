import { isPiLaunchProvider, PI_DEFAULT_MODELS, PI_LAUNCH_PROVIDERS, type PiLaunchProvider } from "@claxedo/agent-runtime-contract"
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai"
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models"
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models"
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models"
import { GROQ_MODELS } from "@earendil-works/pi-ai/providers/groq.models"
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models"
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models"
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models"
import { XAI_MODELS } from "@earendil-works/pi-ai/providers/xai.models"
import { configOptionsPreview, modelAndEffortOptions } from "../../contract"

// The control plane Worker serves this catalog. Pi's provider modules carry
// their API clients, which reach each vendor SDK, so the catalog reads the
// providers' chat model tables: what a built-in provider's `getModels()`
// answers before any model is fetched.
const PI_LAUNCH_MODELS: Record<PiLaunchProvider, Readonly<Record<string, Model<Api>>>> = {
  "openai-codex": OPENAI_CODEX_MODELS, anthropic: ANTHROPIC_MODELS, openai: OPENAI_MODELS, openrouter: OPENROUTER_MODELS,
  google: GOOGLE_MODELS, groq: GROQ_MODELS, xai: XAI_MODELS,
}

export type PiCatalogModel = { id: string; name: string; efforts: ModelThinkingLevel[] }

export function piCatalogModel(provider: string, model: Model<Api>): PiCatalogModel {
  return { id: `${provider}/${model.id}`, name: model.name || model.id, efforts: getSupportedThinkingLevels(model) }
}

export function piLaunchCatalog(providers: readonly string[]): PiCatalogModel[] {
  return providers.filter(isPiLaunchProvider).flatMap((provider) =>
    Object.values(PI_LAUNCH_MODELS[provider]).map((model) => piCatalogModel(provider, model)))
}

export function piDefaultModel(models: readonly PiCatalogModel[]): PiCatalogModel | undefined {
  const defaults = PI_LAUNCH_PROVIDERS.map((provider) => `${provider}/${PI_DEFAULT_MODELS[provider]}`)
  return defaults.map((id) => models.find((row) => row.id === id)).find((row) => row !== undefined) ?? models[0]
}

export function piCatalogOptions(models: readonly PiCatalogModel[], selectedId?: string, effort?: string) {
  const model = models.find((row) => row.id === selectedId) ?? piDefaultModel(models)
  return configOptionsPreview(modelAndEffortOptions({
    models: models.map(({ id, name }) => ({ id, name, connected: true as const })),
    ...(model ? { selected: model.id } : {}),
    efforts: model?.efforts ?? [],
    ...(effort ? { currentEffort: effort } : {}),
  }))
}
