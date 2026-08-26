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

type CollectionValue<T> =
  T extends Map<unknown, infer Value> ? Value : T extends readonly (infer Value)[] ? Value : never

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
  // An EMPTY catalog never replaces a populated one.
  //
  // This rule used to live at exactly one call site — `setProviderQuery` in
  // `app/boot/data/bootstrap.ts` — while the merge that actually owns "how two
  // provider catalogs combine" did not know it. Four writers reach this key
  // (`setBootstrapProviderQueries`, the directory bootstrap's provider fetch,
  // the globalSync patch handler at `providers/global-sync/provider.tsx`, and
  // `providerListQuery`'s own `structuralSharing`), and only ONE of them was
  // careful. The reachable case is a bootstrap payload with no `provider` field:
  // `bootstrapGlobal` normalizes that to `{ all: [], connected: [], default: {} }`
  // and patches it straight in, wiping a catalog the user could already see.
  //
  // Keeping `previous` whole rather than merging field-by-field is deliberate:
  // it is exactly what the careful caller did by declining to write at all, so
  // this is behaviour-preserving there and behaviour-fixing everywhere else.
  if (index.all.size === 0 && previous.all.size > 0) return previous
  return {
    ...index,
    all: new Map(
      [...index.all].map(([id, provider]) => {
        const detail = previous.all.get(id)
        if (!detail || Object.keys(detail.models).length <= Object.keys(provider.models).length) return [id, provider]
        return [
          id,
          {
            ...detail,
            id: provider.id,
            name: provider.name,
            source: provider.source,
          },
        ]
      }),
    ),
  }
}

export function compactProviderListForStorage(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  const catalog = input as { all?: unknown; connected?: unknown; default?: unknown }
  const all = catalog.all instanceof Map ? [...catalog.all.values()] : Array.isArray(catalog.all) ? catalog.all : []
  const connected = Array.isArray(catalog.connected)
    ? catalog.connected.filter((item): item is string => typeof item === "string")
    : []
  const defaults =
    catalog.default && typeof catalog.default === "object" && !Array.isArray(catalog.default)
      ? (catalog.default as Record<string, unknown>)
      : {}
  return {
    ...catalog,
    all: new Map(
      all.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return []
        const provider = item as Record<string, unknown>
        if (typeof provider.id !== "string") return []
        const models =
          provider.models && typeof provider.models === "object" && !Array.isArray(provider.models)
            ? (provider.models as Record<string, unknown>)
            : {}
        const configuredDefault = defaults[provider.id]
        const defaultModel = typeof configuredDefault === "string" ? configuredDefault : undefined
        return [
          [
            provider.id,
            {
              id: provider.id,
              name: typeof provider.name === "string" ? provider.name : provider.id,
              models:
                connected.includes(provider.id) && defaultModel && models[defaultModel]
                  ? { [defaultModel]: models[defaultModel] }
                  : {},
            },
          ] as const,
        ]
      }),
    ),
  }
}
