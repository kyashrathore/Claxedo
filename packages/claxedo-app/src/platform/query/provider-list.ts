import type { ProviderListResponse } from "@/platform/query/control-plane"
import { asRecord, recordOrEmpty } from "@/lib/record"
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

/**
 * Whether a body from `/agent-config/providers` is a provider catalog.
 *
 * Checks what the catalog is keyed and filtered by: `all` as providers that
 * carry an `id` and a `models` map, `connected` as provider ids, and `default`
 * as a provider id → model id map. Those are the fields this module indexes and
 * the ones a wrong body silently breaks — `normalizeProviderList` used to take
 * whatever `response.json()` returned on the strength of an `as`, so a body
 * with no `all` produced an empty catalog and an unexplained empty model
 * picker.
 *
 * Model BODIES are deliberately not re-derived here. `ClaxedoProviderModel` is
 * the server's own catalog schema; a second copy of it in the client would be
 * one more thing to keep in step with the server, and no reader in this app
 * benefits from rejecting a catalog because one model grew a field.
 */
export function isProviderListResponse(value: unknown): value is ProviderListResponse {
  const catalog = asRecord(value)
  if (!catalog) return false
  const isProvider = (entry: unknown) => {
    const provider = asRecord(entry)
    return typeof provider?.id === "string" && !!asRecord(provider.models)
  }
  if (!Array.isArray(catalog.all) || !catalog.all.every(isProvider)) return false
  if (!Array.isArray(catalog.connected) || !catalog.connected.every((id) => typeof id === "string")) return false
  const defaults = asRecord(catalog.default)
  return !!defaults && Object.values(defaults).every((model) => typeof model === "string")
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

/** Drop providers the user disabled in global config from the connected set. */
export function filterConnectedByDisabledProviders(
  input: NormalizedProviderListResponse,
  disabledProviders: readonly string[] | undefined,
): NormalizedProviderListResponse {
  if (!disabledProviders?.length) return input
  const disabled = new Set(disabledProviders)
  const connected = input.connected.filter((id) => !disabled.has(id))
  if (connected.length === input.connected.length) return input
  return { ...input, connected }
}

export function providerNeedsDetailHydration(
  cached: NormalizedProviderListResponse | undefined,
  providerId: string,
): boolean {
  const provider = cached?.all.get(providerId)
  if (!provider) return true
  const modelCount = Object.keys(provider.models).length
  const connected = cached?.connected.includes(providerId) ?? false
  if (connected) return modelCount <= 1
  return modelCount === 0
}

export function mergeProviderIndexWithDetails(
  previous: NormalizedProviderListResponse | undefined,
  index: NormalizedProviderListResponse,
) {
  if (!previous) return index
  // An empty catalog never replaces a populated one.
  //
  // Four call sites write this cache key — `setBootstrapProviderQueries`, the
  // directory bootstrap's provider fetch, the globalSync patch handler at
  // `providers/global-sync/provider.tsx`, and `providerListQuery`'s own
  // `structuralSharing` — so the rule has to hold at the merge, not at any one
  // of them. The reachable case is a bootstrap payload with no `provider`
  // field: `bootstrapGlobal` normalizes that to
  // `{ all: [], connected: [], default: {} }` and patches it straight in,
  // wiping a catalog the user could already see.
  //
  // Keeping `previous` whole rather than merging field-by-field is
  // deliberate: declining to write at all is exactly the behavior a careful
  // caller would choose, so this is behavior-preserving there and
  // behavior-fixing everywhere else.
  if (index.all.size === 0 && previous.all.size > 0) return previous
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
  const defaults = recordOrEmpty(catalog.default)
  return {
    ...catalog,
    all: new Map(all.flatMap((item) => {
      const provider = asRecord(item)
      if (!provider || typeof provider.id !== "string") return []
      const models = recordOrEmpty(provider.models)
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
