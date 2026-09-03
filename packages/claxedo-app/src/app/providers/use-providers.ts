import { useSDK } from "@/app/providers/sdk/sdk"
import { createMemo } from "solid-js"
import { useShellQueryOptions as useQueryOptions } from "@/app/integrations/sync/query-options"
import { useWorkspaceQuery } from "../../features/workspaces/data/use-workspace-query"
import type { NormalizedProviderListResponse } from "@/platform/query/provider-list"
import { popularProviders } from "@/platform/query/provider-list"
import { loadProviderDetailsOnce, updateProviderQueryData } from "@/platform/query/provider-cache"
import { authFetch, getClaxedoServerUrl } from "@/platform/api/api"
import { providerAuthQuery, providerDetailsQuery } from "@/platform/query/control-plane"

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

type HarnessInput = string | (() => string)
type ScopeInput = string | undefined | (() => string | undefined)

/**
 * The (workspace-or-directory scope, harness) a catalog read is about.
 *
 * Inside a workspace SDK scope the scope is that pane's STABLE workspace
 * identity: when it resolves a workspaceId, the `workspace:<id>` ref form, so
 * the query routes through the relay regardless of whether `sdk.directory` is
 * the workspace-ref or the runtime's filesystem path (the latter flickered the
 * provider list to the empty central catalog → "Select model"). Outside one,
 * the scope is whatever the caller names; `undefined` names the CENTRAL
 * server's own runtime, which is a real scope — the catalog of the harness
 * installed on the machine the app is talking to, belonging to no workspace.
 */
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

/**
 * The provider AUTHENTICATION the machine serving this scope holds for this
 * harness. Same triple as the catalog: two machines answering the same harness
 * name hold different credentials for it.
 */
export function useProviderAuth(harnessType: HarnessInput, scope?: ScopeInput) {
  const { sdk, dir, harness } = useProviderScope(harnessType, scope)
  return useWorkspaceQuery(() => ({
    ...providerAuthQuery({
      baseUrl: getClaxedoServerUrl(),
      directory: dir() || null,
      harnessType: harness(),
      request: sdk ? (url, init) => sdk.request(`${url.pathname}${url.search}`, init) : authFetch,
    }),
    workspaceId: sdk?.workspaceId,
  }))
}

export function useProviders(harnessType: HarnessInput, scope?: ScopeInput) {
  const queryOptions = useQueryOptions()
  const { sdk, dir, harness } = useProviderScope(harnessType, scope)
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
