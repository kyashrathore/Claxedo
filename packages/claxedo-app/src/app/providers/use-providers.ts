import { useSDK } from "@/app/providers/sdk/sdk"
import { createMemo } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"
import type { NormalizedProviderListResponse } from "@/platform/query/provider-list"
import { popularProviders } from "@/platform/query/provider-list"
import { loadProviderDetailsOnce, updateProviderQueryData } from "@/platform/query/provider-cache"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { providerAuthQuery, providerDetailsQuery } from "@/platform/query/control-plane"
import { hasManagedProviderCredentials } from "@/platform/identity/harness-selection"

export { popularProviders } from "@/platform/query/provider-list"

type ProviderList = NormalizedProviderListResponse
type ProviderMap = ProviderList["all"]
type Provider = ProviderMap extends Map<string, infer T> ? T : never

function mergeProviderQuery(input: {
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

/**
 * A defensive copy of the catalog index.
 *
 * Every writer of this query produces a `Map` — `normalizeProviderList`,
 * `compactProviderListForStorage`, and the persister's `mapReviver` all do —
 * so this only has to guard the one shape that is NOT one: a blob persisted
 * before the persister learned to tag Maps restores `all` as a plain object,
 * and `new Map(thatObject)` throws. The rebuild-from-an-array branch that used
 * to sit here had no producer, and rebuilding a row meant asserting an
 * `id`-and-`models` object into the control plane's whole `ClaxedoProvider`.
 */
function providerMap(input: unknown): ProviderMap {
  return input instanceof Map ? new Map(input) : new Map()
}

function connectedIds(input: unknown) {
  return Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : []
}

const popularProviderSet = new Set(popularProviders)

type HarnessInput = string | (() => string)
type ScopeInput = string | undefined | (() => string | undefined)

/** Workspace identity partitions model selection caches, not catalog transport. */
function useProviderScope(harnessType: HarnessInput, scope?: ScopeInput) {
  let sdk: ReturnType<typeof useSDK> | undefined
  try {
    sdk = useSDK()
  } catch {
    /* optional outside workspace sdk scope */
  }
  const dir = createMemo(() => {
    const workspaceId = sdk?.workspaceId
    if (workspaceId) return `workspace:${workspaceId}`
    if (sdk?.directory) return sdk.directory
    return (typeof scope === "function" ? scope() : scope) ?? ""
  })
  const harness = createMemo(() => (typeof harnessType === "function" ? harnessType() : harnessType))
  return { sdk, dir, harness }
}

/** Native provider authentication is read from the control plane. */
export function useProviderAuth(harnessType: HarnessInput, scope?: ScopeInput) {
  const { dir, harness } = useProviderScope(harnessType, scope)
  return useQuery(() => ({
    ...providerAuthQuery({
      baseUrl: getClaxedoServerUrl(),
      directory: dir() || null,
      harnessType: harness(),
      request: authFetch,
    }),
    enabled: !!harness(),
  }))
}

export function useProviders(harnessType: HarnessInput, scope?: ScopeInput) {
  const queryOptions = useQueryOptions()
  const { dir, harness } = useProviderScope(harnessType, scope)
  const providerOptions = () => queryOptions.providers(dir() || null, harness())
  const providerQuery = useQuery(() => ({
    ...providerOptions(),
    enabled: hasManagedProviderCredentials(harness()),
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
    if (!hasManagedProviderCredentials(harness())) return Promise.reject(new Error("Provider credentials are managed by this harness externally"))
    const queryKey = providerOptions().queryKey
    return loadProviderDetailsOnce(queryKey, providerId, async () => {
      const detail = await providerDetailsQuery({
        baseUrl: getClaxedoServerUrl(),
        providerId,
        directory: dir() || null,
        harnessType: harness(),
        request: authFetch,
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
    // Distinguish an authoritative empty catalog from the query's pre-fetch
    // empty placeholder. Draft-default resolution must not declare a saved
    // model unavailable before the first provider response arrives.
    resolved: () => providerQuery.isFetched,
    loading: () => providerQuery.isLoading || providerQuery.isFetching,
    error: () => providerQuery.error instanceof Error ? providerQuery.error.message : undefined,
    refresh: () => providerQuery.refetch(),
    load,
    /** Same key `useQuery` / `load` use — patch/invalidate this after connect/disconnect. */
    queryKey: () => providerOptions().queryKey,
    all,
    default: () => state().default,
    popular: () => [...all().values()].filter((p) => popularProviderSet.has(p.id)),
    connected: connectedProviders,
  }
}
