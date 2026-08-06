import { useSDK } from "@/app/providers/sdk/sdk"
import { createMemo } from "solid-js"
import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"
import { useWorkspaceQuery } from "../../features/workspaces/data/use-workspace-query"
import type { NormalizedProviderListResponse } from "@/platform/query/provider-list"
import { popularProviders, normalizeProviderList, type ProviderListResponse } from "@/platform/query/provider-list"
import { queryClient } from "@/platform/query/query-client"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"

export { popularProviders } from "@/platform/query/provider-list"

type ProviderList = NormalizedProviderListResponse
type ProviderMap = ProviderList["all"]
type Provider = ProviderMap extends Map<string, infer T> ? T : never

export function mergeProviderQuery(input: {
  queryKey: readonly unknown[]
  current: NormalizedProviderListResponse
  providerId: string
  provider: Provider
  connected?: string[]
  default?: NormalizedProviderListResponse["default"]
  ensureConnected?: boolean
}) {
  queryClient.setQueryData<NormalizedProviderListResponse | undefined>(
    input.queryKey,
    (cached) => {
      const providerList = cached ?? input.current
      return {
        ...providerList,
        all: new Map(providerList.all).set(input.providerId, input.provider),
        connected: input.ensureConnected && !providerList.connected.includes(input.providerId)
          ? [...providerList.connected, input.providerId]
          : input.connected ?? providerList.connected,
        default: input.default ?? providerList.default,
      }
    },
  )
}

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

export function useProviders(harnessType?: string | (() => string | undefined)) {
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
  const harness = createMemo(() => typeof harnessType === "function" ? harnessType() : harnessType)
  // The provider/model catalog routes through the relay for a workspace-backed
  // scope (`workspace:<id>` ref above) — gate it on the WorkspaceConnection
  // authority so the model picker cannot fire-and-fail against an offline
  // workspace (the old "Select model" flicker / 403 source). Local/central
  // scopes have no relay workspaceId → no-op gate (always ready).
  const providerOptions = () => queryOptions.providers(dir() || null, harness())
  const providerQuery = useWorkspaceQuery(() => ({
    ...providerOptions(),
    workspaceId: sdk?.workspaceId,
  }))
  const state = (): NormalizedProviderListResponse => providerQuery.data ?? {
    all: new Map(),
    connected: [],
    default: {},
  }
  const all = () => providerMap(state().all)
  const connected = () => connectedIds(state().connected)
  const detailed = new Set<string>()
  const pending = new Map<string, Promise<void>>()
  const load = (providerId: string) => {
    if (detailed.has(providerId)) return Promise.resolve()
    const existing = pending.get(providerId)
    if (existing) return existing
    const task = (async () => {
      const params = new URLSearchParams({ provider: providerId })
      if (harness()) params.set("harness", harness()!)
      if (dir()) params.set("directory", dir())
      const pathname = `/provider?${params.toString()}`
      const response = sdk
        ? await sdk.request(pathname, { headers: { Accept: "application/json" } })
        : await authFetch(new URL(pathname, getClaxedoServerUrl()), { headers: { Accept: "application/json" } })
      if (!response.ok) throw new Error((await response.text()) || `Failed to load ${providerId} models`)
      const detail = normalizeProviderList(await response.json() as ProviderListResponse)
      const provider = detail.all.get(providerId)
      if (!provider) throw new Error(`Provider ${providerId} was not returned by the runtime`)
      mergeProviderQuery({
        queryKey: providerOptions().queryKey,
        current: state(),
        providerId,
        provider,
        connected: detail.connected,
        default: detail.default,
      })
      detailed.add(providerId)
    })().finally(() => pending.delete(providerId))
    pending.set(providerId, task)
    return task
  }
  return {
    state,
    loading: () => providerQuery.isLoading || providerQuery.isFetching,
    error: () => providerQuery.error instanceof Error ? providerQuery.error.message : undefined,
    refresh: () => providerQuery.refetch(),
    load,
    all,
    default: () => state().default,
    popular: () => [...all().values()].filter((p) => popularProviderSet.has(p.id)),
    connected: () => {
      const connectedSet = new Set(connected())
      return [...all().values()].filter((p) => connectedSet.has(p.id))
    },
  }
}
