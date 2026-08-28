import { useSDK } from "@/app/providers/sdk/sdk"
import { createMemo } from "solid-js"
import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"
import { useWorkspaceQuery } from "../../features/workspaces/data/use-workspace-query"
import type { NormalizedProviderListResponse } from "@/platform/query/provider-list"
import { popularProviders } from "@/platform/query/provider-list"
import { loadProviderDetailsOnce, updateProviderQueryData } from "@/platform/query/provider-cache"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { providerDetailsQuery } from "@/platform/query/control-plane"

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
  updateProviderQueryData(input.queryKey, (cached) => {
    const providerList = cached ?? input.current
    return {
      ...providerList,
      all: new Map(providerList.all).set(input.providerId, input.provider),
      connected: input.ensureConnected && !providerList.connected.includes(input.providerId)
        ? [...providerList.connected, input.providerId]
        : input.connected ?? providerList.connected,
      default: input.default ?? providerList.default,
    }
  })
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
  // provider list to the empty central → "Select model"). Local and central
  // scopes use their directory string as the stable identity.
  const dir = createMemo(() => {
    const workspaceId = sdk?.workspaceId
    if (workspaceId) return `workspace:${workspaceId}`
    return sdk?.directory || ""
  })
  // Unqualified `/provider` follows the workspace default harness (often agents),
  // not OpenCode. Callers that omit a harness historically expect the OpenCode
  // catalog — default to it so settings popular rows and model pickers stay filled.
  const harness = createMemo(() => {
    const value = typeof harnessType === "function" ? harnessType() : harnessType
    return value || "opencode"
  })
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
  const all = createMemo(() => providerMap(state().all))
  const connected = createMemo(() => connectedIds(state().connected))
  const connectedProviders = createMemo(() => {
    const connectedSet = new Set(connected())
    return [...all().values()].filter((provider) => connectedSet.has(provider.id))
  })
  const load = (providerId: string) => {
    const queryKey = providerOptions().queryKey
    return loadProviderDetailsOnce(queryKey, providerId, async () => {
      const detail = await providerDetailsQuery({
        baseUrl: getClaxedoServerUrl(),
        providerId,
        directory: dir() || null,
        harnessType: harness(),
        request: sdk
          ? (url, init) => sdk.request(`${url.pathname}${url.search}`, init)
          : authFetch,
      }).queryFn()
      const provider = detail.all.get(providerId)
      if (!provider) throw new Error(`Provider ${providerId} was not returned by the runtime`)
      mergeProviderQuery({
        queryKey,
        current: state(),
        providerId,
        provider,
        connected: detail.connected,
        default: detail.default,
      })
    })
  }
  return {
    state,
    loading: () => providerQuery.isLoading || providerQuery.isFetching,
    error: () => providerQuery.error instanceof Error ? providerQuery.error.message : undefined,
    refresh: () => providerQuery.refetch(),
    load,
    /** Same key `useWorkspaceQuery` / `load` use — patch/invalidate this after connect/disconnect. */
    queryKey: () => providerOptions().queryKey,
    all,
    default: () => state().default,
    popular: () => [...all().values()].filter((p) => popularProviderSet.has(p.id)),
    connected: connectedProviders,
  }
}
