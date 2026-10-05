import { isPiLaunchProvider, PI_DEFAULT_MODELS, PI_LAUNCH_PROVIDERS, type PiLaunchProvider } from "@claxedo/agent-runtime-contract"
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

export function piDefaultModel(models: readonly PiCatalogModel[]): PiCatalogModel | undefined {
  const defaults = PI_LAUNCH_PROVIDERS.map((provider) => `${provider}/${PI_DEFAULT_MODELS[provider]}`)
  return defaults.map((id) => models.find((row) => row.id === id)).find((row) => row !== undefined) ?? models[0]
}

const MATCH_DEFAULT_FAMILY: Readonly<Partial<Record<PiLaunchProvider, string>>> = { anthropic: "claude-sonnet" }

type Release = { model: PiCatalogModel; family: string; version: number[] }

function release(provider: string, model: PiCatalogModel): Release | undefined {
  const parsed = /^(.+?)-(\d{1,2}(?:-\d{1,2})*)$/.exec(model.id.slice(provider.length + 1))
  return parsed ? { model, family: parsed[1]!, version: parsed[2]!.split("-").map(Number) } : undefined
}

function newer(left: Release, right: Release) {
  const order = left.version.map((part, index) => part - (right.version[index] ?? -1)).find((step) => step !== 0)
  return (order ?? left.version.length - right.version.length) > 0 ? left : right
}

function familyOf(releases: readonly Release[], hint: string) {
  return releases.map((row) => row.family).find((family) => hint.includes(family) || hint.includes(family.split("-").at(-1)!))
}

export function piMatchingModel(provider: PiLaunchProvider, hint?: string): PiCatalogModel | undefined {
  const models = piLaunchCatalog([provider])
  const exact = hint ? models.find((row) => row.id === `${provider}/${hint}`) : undefined
  if (exact) return exact
  const releases = models.flatMap((model) => release(provider, model) ?? [])
  const family = (hint ? familyOf(releases, hint) : undefined) ?? MATCH_DEFAULT_FAMILY[provider]
  const newest = releases.filter((row) => row.family === family).reduce<Release | undefined>((best, row) => best ? newer(row, best) : row, undefined)
  return newest?.model ?? piDefaultModel(models)
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
