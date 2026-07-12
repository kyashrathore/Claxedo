import { useSDK } from "@/app/providers/sdk/sdk"
import { createMemo } from "solid-js"
import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"
import { useWorkspaceQuery } from "../../features/workspaces/data/use-workspace-query"
import type { NormalizedProviderListResponse } from "@/platform/query/provider-list"
import { popularProviders } from "@/platform/query/provider-list"

export { popularProviders } from "@/platform/query/provider-list"

type ProviderList = NormalizedProviderListResponse
type ProviderMap = ProviderList["all"]
type Provider = ProviderMap extends Map<string, infer T> ? T : never

function providerFromUnknown(input: unknown): Provider | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  const provider = input as Partial<Provider> & { id?: unknown; models?: unknown }
  if (typeof provider.id !== "string") return
  return {
    ...provider,
    id: provider.id,
    models: provider.models && typeof provider.models === "object" && !Array.isArray(provider.models)
      ? provider.models as Provider["models"]
      : {},
  } as Provider
}

function providerMap(input: unknown): ProviderMap {
  if (input instanceof Map) return input as ProviderMap
  if (!Array.isArray(input)) return new Map()
  return new Map(input.flatMap((item) => {
    const provider = providerFromUnknown(item)
    return provider ? [[provider.id, provider] as const] : []
  }))
}

function connectedIds(input: unknown) {
  return Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : []
}

const popularProviderSet = new Set(popularProviders)

export function useProviders() {
  const queryOptions = useQueryOptions()
  let sdk: ReturnType<typeof useSDK> | undefined
  try {
    sdk = useSDK()
  } catch {
    /* optional outside workspace sdk scope */
  }
  // Route the provider list by the scope's STABLE workspace identity. When the
  // scope resolves a workspaceId, use the `workspace:<id>` ref form so the query
  // routes through the relay regardless of whether `sdk.directory` is the
  // workspace-ref or the runtime's filesystem path (the latter flickers the
  // provider list to the empty central → "Select model"). Falls back to the
  // directory string for local/non-workspace scopes.
  const dir = createMemo(() => {
    const workspaceId = sdk?.workspaceId
    if (workspaceId) return `workspace:${workspaceId}`
    return sdk?.directory || ""
  })
  // The provider/model catalog routes through the relay for a workspace-backed
  // scope (`workspace:<id>` ref above) — gate it on the WorkspaceConnection
  // authority so the model picker cannot fire-and-fail against an offline
  // workspace (the old "Select model" flicker / 403 source). Local/central
  // scopes have no relay workspaceId → no-op gate (always ready).
  const providerQuery = useWorkspaceQuery(() => ({
    ...queryOptions.providers(dir() || null),
    workspaceId: sdk?.workspaceId,
  }))
  const state = (): NormalizedProviderListResponse => providerQuery.data ?? {
    all: new Map(),
    connected: [],
    default: {},
  }
  const all = () => providerMap(state().all)
  const connected = () => connectedIds(state().connected)
  return {
    state,
    loading: () => providerQuery.isLoading || providerQuery.isFetching,
    all,
    default: () => state().default,
    popular: () => [...all().values()].filter((p) => popularProviderSet.has(p.id)),
    connected: () => {
      const connectedSet = new Set(connected())
      return [...all().values()].filter((p) => connectedSet.has(p.id))
    },
    paid: () => {
      const connectedSet = new Set(connected())
      return [...all().entries()].filter(
        ([id]) =>
          connectedSet.has(id) &&
          (id !== "opencode" || Object.values(all().get(id)?.models ?? {}).some((m) => m.cost?.input)),
      )
    },
  }
}
