import { createMemo, createResource, createSignal, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { PlacementId, Server } from "@/server"
import { catalogHarnessId, isCatalogHarness, type HarnessType } from "./profile"

export const POPULAR_PROVIDERS: readonly string[] = ["opencode", "opencode-go", "anthropic", "github-copilot", "openai", "google", "openrouter", "vercel"]

export function hydrateConnectedProviderDetails(providers: {
  connected: () => Array<{ id: string }>
  load: (providerId: string) => Promise<void>
}) {
  return Promise.allSettled(providers.connected().map((provider) => providers.load(provider.id)))
}

export function createProviderCatalog(input: {
  server: Server
  harness: Accessor<string>
  placementId?: Accessor<PlacementId | undefined>
  eager?: boolean
}) {
  const [requested, setRequested] = createSignal(input.eager === true)
  const placementId = () => input.placementId?.()
  const query = useQuery(() => ({
    ...input.server.queries.providerCatalogs.catalog(input.harness(), placementId()),
    enabled: input.harness() !== "" && requested(),
  }))
  const catalog = () => (input.harness() ? query.data : undefined)
  const all = createMemo(() => new Map((catalog()?.all ?? []).map((provider) => [provider.id, provider] as const)))
  const connected = createMemo(() => {
    const ids = new Set(catalog()?.connected ?? [])
    return [...all().values()].filter((provider) => ids.has(provider.id))
  })
  return {
    request: () => setRequested(true),
    resolved: () => input.harness() !== "" && query.isFetched,
    loading: () => input.harness() !== "" && query.isFetching,
    error: () => (query.error ? query.error.message || `Failed to load ${input.harness()} models` : undefined),
    refresh: async () => {
      await query.refetch()
    },
    load: async (providerId: string) => {
      if (input.harness()) await input.server.providerCatalogs.loadDetail(input.harness(), providerId, placementId())
    },
    scopeKey: () => [input.harness(), placementId() ?? ""] as const,
    all,
    default: () => catalog()?.default ?? {},
    connected,
  }
}

export type ProviderCatalogRead = ReturnType<typeof createProviderCatalog>

export function createProviderCatalogRows(providers: ProviderCatalogRead) {
  return createMemo(() => {
    const connected = new Set(providers.connected().map((provider) => provider.id))
    const rows = [...providers.all().values()].flatMap((provider) =>
      Object.values(provider.models).map((item) => ({
        id: item.id,
        name: item.name,
        provider: { id: provider.id, name: provider.name },
        connected: item.connected,
        free: item.free,
      })),
    )
    return {
      connected,
      rows,
      eligibleModels: rows
        .filter((item) => item.connected)
        .map((item) => ({ providerId: item.provider.id, modelId: item.id })),
    }
  })
}

export type ProviderCatalogRows = ReturnType<ReturnType<typeof createProviderCatalogRows>>

export function createProviderCatalogReadiness(input: { providers: ProviderCatalogRead; harness: Accessor<HarnessType | undefined> }) {
  const hydrationKey = () => JSON.stringify([
    input.providers.scopeKey(),
    input.providers.connected().map((provider) => provider.id).sort(),
  ])
  const answered = () =>
    !!catalogHarnessId(input.harness())
    && input.providers.resolved()
    && !input.providers.loading()
    && !input.providers.error()
  const [hydrated] = createResource(
    () => answered() && hydrationKey(),
    async (key) => {
      await hydrateConnectedProviderDetails(input.providers)
      return key
    },
  )
  const ready = () => answered() && hydrated.latest === hydrationKey()
  const unread = () => !!input.harness() && isCatalogHarness(input.harness()!) && !input.providers.resolved()
  const variants = (model: { providerId?: string; modelId?: string }) => {
    const provider = model.providerId ? input.providers.all().get(model.providerId) : undefined
    const row = Object.values(provider?.models ?? {}).find((item) => item.id === model.modelId)
    return Object.keys(row?.variants ?? {})
  }
  return { ready, unread, variants }
}
