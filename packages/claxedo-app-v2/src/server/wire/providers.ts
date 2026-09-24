import { ServerError } from "../errors"
import type { ModelChoice } from "../types"

export type ProviderCatalog = { readonly models: readonly ModelChoice[]; readonly connected: readonly string[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function modelChoices(providerId: string, model: unknown): ModelChoice[] {
  if (!isRecord(model) || typeof model.id !== "string" || model.connected !== true) return []
  const base = { providerId, modelId: model.id }
  const variants = isRecord(model.variants) ? Object.keys(model.variants) : []
  return [base, ...variants.map((variant) => ({ ...base, variant }))]
}

export function providerCatalogFromWire(body: unknown): ProviderCatalog {
  const all = isRecord(body) ? body.all : undefined
  if (!Array.isArray(all)) throw new ServerError({ class: "internal", message: "The provider catalog answered without providers" })
  const connected = isRecord(body) && Array.isArray(body.connected) ? body.connected.filter((item): item is string => typeof item === "string") : []
  const models = all.flatMap((provider) => {
    if (!isRecord(provider) || typeof provider.id !== "string" || !isRecord(provider.models)) return []
    const providerId = provider.id
    return Object.values(provider.models).flatMap((model) => modelChoices(providerId, model))
  })
  return { models, connected }
}
