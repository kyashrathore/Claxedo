import type { ProviderListResponse } from "@/platform/query/control-plane"
export type { ProviderListResponse } from "@/platform/query/control-plane"

export const popularProviders = [
  "opencode",
  "opencode-go",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]

type CollectionValue<T> = T extends Map<unknown, infer Value>
  ? Value
  : T extends readonly (infer Value)[]
    ? Value
    : never

export type NormalizedProviderListResponse = Omit<ProviderListResponse, "all"> & {
  all: Map<string, CollectionValue<ProviderListResponse["all"]>>
}

export function normalizeProviderList(input: ProviderListResponse): NormalizedProviderListResponse {
  const all = input.all instanceof Map ? [...input.all.values()] : Array.isArray(input.all) ? input.all : []
  return {
    ...input,
    all: new Map(
      all.map(
        (provider) =>
          [
            provider.id,
            {
              ...provider,
              models: Object.fromEntries(
                Object.entries(provider.models).filter(([, info]) => info.status !== "deprecated"),
              ),
            },
          ] as const,
      ),
    ),
  }
}

export function mergeProviderIndexWithDetails(
  previous: NormalizedProviderListResponse | undefined,
  index: NormalizedProviderListResponse,
) {
  if (!previous) return index
  return {
    ...index,
    all: new Map([...index.all].map(([id, provider]) => {
      const detail = previous.all.get(id)
      if (!detail || Object.keys(detail.models).length <= Object.keys(provider.models).length) return [id, provider]
      return [id, {
        ...detail,
        id: provider.id,
        name: provider.name,
        source: provider.source,
      }]
    })),
  }
}

export function compactProviderListForStorage(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const catalog = input as { all?: unknown; connected?: unknown; default?: unknown }
  const all = catalog.all instanceof Map ? [...catalog.all.values()] : Array.isArray(catalog.all) ? catalog.all : []
  const connected = Array.isArray(catalog.connected)
    ? catalog.connected.filter((item): item is string => typeof item === "string")
    : []
  const defaults = catalog.default && typeof catalog.default === "object" && !Array.isArray(catalog.default)
    ? catalog.default as Record<string, unknown>
    : {}
  return {
    ...catalog,
    all: new Map(all.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return []
      const provider = item as Record<string, unknown>
      if (typeof provider.id !== "string") return []
      const models = provider.models && typeof provider.models === "object" && !Array.isArray(provider.models)
        ? provider.models as Record<string, unknown>
        : {}
      const configuredDefault = defaults[provider.id]
      const defaultModel = typeof configuredDefault === "string" ? configuredDefault : undefined
      return [[provider.id, {
        id: provider.id,
        name: typeof provider.name === "string" ? provider.name : provider.id,
        models: connected.includes(provider.id) && defaultModel && models[defaultModel]
          ? { [defaultModel]: models[defaultModel] }
          : {},
      }] as const]
    })),
  }
}
