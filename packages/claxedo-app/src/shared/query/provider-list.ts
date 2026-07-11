import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client"
import type { NormalizedProviderListResponse } from "@/session-client"

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
