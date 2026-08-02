import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client"

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
