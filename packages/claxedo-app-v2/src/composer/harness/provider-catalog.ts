import { createMemo, createSignal, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { Server } from "@/server"

export const POPULAR_PROVIDERS: readonly string[] = ["opencode", "opencode-go", "anthropic", "github-copilot", "openai", "google", "openrouter", "vercel"]

export function hydrateConnectedProviderDetails(providers: {
  connected: () => Array<{ id: string }>
  load: (providerId: string) => Promise<void>
}) {
  return Promise.allSettled(providers.connected().map((provider) => providers.load(provider.id)))
}

export function createProviderCatalog(input: { server: Server; harness: Accessor<string>; eager?: boolean }) {
  const [requested, setRequested] = createSignal(input.eager === true)
  const query = useQuery(() => ({ ...input.server.queries.providerCatalogs.catalog(input.harness()), enabled: input.harness() !== "" && requested() }))
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
      if (input.harness()) await input.server.providerCatalogs.loadDetail(input.harness(), providerId)
    },
    queryKey: () => [input.harness()] as const,
    all,
    default: () => catalog()?.default ?? {},
    connected,
  }
}
