import { PI_DEFAULT_MODELS, type PiLaunchProvider } from "@claxedo/agent-runtime-contract"
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models"
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models"
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models"

export type PiModelChoice = { id: string; name: string }

type Release = { model: PiModelChoice; family: string; version: number[] }

const HARNESS_ACCOUNT_MODELS: Partial<Record<PiLaunchProvider, Readonly<Record<string, { id: string; name: string }>>>> = {
  anthropic: ANTHROPIC_MODELS, openai: OPENAI_MODELS, "openai-codex": OPENAI_CODEX_MODELS,
}

const DEFAULT_FAMILY: Partial<Record<PiLaunchProvider, string>> = { anthropic: "claude-sonnet" }

function release(model: PiModelChoice, bare: string): Release | undefined {
  const parsed = /^(.+?)-(\d{1,2}(?:-\d{1,2})*)$/.exec(bare)
  return parsed ? { model, family: parsed[1]!, version: parsed[2]!.split("-").map(Number) } : undefined
}

function newer(left: Release, right: Release) {
  const order = left.version.map((part, index) => part - (right.version[index] ?? -1)).find((step) => step !== 0)
  return (order ?? left.version.length - right.version.length) > 0 ? left : right
}

function familyOf(releases: readonly Release[], hint: string) {
  return releases.map((row) => row.family).find((family) => hint.includes(family) || hint.includes(family.split("-").at(-1)!))
}

export function piMatchingModel(provider: PiLaunchProvider, hint?: string): PiModelChoice | undefined {
  const models = Object.values(HARNESS_ACCOUNT_MODELS[provider] ?? {}).map((model) => ({ bare: model.id, model: { id: `${provider}/${model.id}`, name: model.name || model.id } }))
  const exact = models.find((row) => row.bare === hint)
  if (exact) return exact.model
  const releases = models.flatMap((row) => release(row.model, row.bare) ?? [])
  const family = (hint ? familyOf(releases, hint) : undefined) ?? DEFAULT_FAMILY[provider]
  const newest = releases.filter((row) => row.family === family).reduce<Release | undefined>((best, row) => best ? newer(row, best) : row, undefined)
  return newest?.model ?? models.find((row) => row.bare === PI_DEFAULT_MODELS[provider])?.model ?? models[0]?.model
}
