import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import { useQuery, type UseQueryResult } from "@tanstack/solid-query"
import type { HarnessId } from "@claxedo/agent-runtime-contract"
import { createProviderCatalog, harnessModelPickerProvider, modelGroupKey } from "@/composer"
import { nativeHarness, type HarnessSelection } from "@/lib/harness-selection"
import { toAppError, useServer, type HarnessOptionChoice, type HarnessOptions, type ModelChoice } from "@/server"
import { catalogProviders } from "./catalog-rules"
import { piModelChoices } from "./model"
import type { ReadyPlacement } from "./settings-placement"

export type ModelItem = { readonly id: string; readonly name: string; readonly provider: { readonly id: string; readonly name: string }; readonly connected?: boolean }

export type SourceGroup = {
  readonly key: string
  readonly groupKey: string
  readonly providerId: string
  readonly providerName: string
  readonly connected: boolean
  readonly items: readonly ModelItem[]
  readonly defaults: Readonly<Record<string, string>>
}

export type ModelSource =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "ready"; readonly groups: readonly SourceGroup[] }

export function sourceGroups(source: ModelSource): readonly SourceGroup[] {
  return source.kind === "ready" ? source.groups : []
}

export const modelKeyOf = (item: ModelItem): ModelChoice => ({ providerId: item.provider.id, modelId: item.id })

export function groupContext(group: SourceGroup, item: ModelItem) {
  return { defaults: group.defaults, group: group.groupKey, ...(item.connected === undefined ? {} : { connected: item.connected }) }
}

export function harnessGroups(selection: HarnessSelection, models: readonly HarnessOptionChoice[]): SourceGroup[] {
  const groups = new Map<string, { providerId: string; providerName: string; items: ModelItem[] }>()
  for (const model of models) {
    const provider = harnessModelPickerProvider(selection, { id: model.id })
    const key = `${provider.id}\n${provider.name}`
    const group = groups.get(key) ?? { providerId: provider.id, providerName: provider.name, items: [] }
    group.items.push({ id: model.id, name: model.name, provider, connected: model.connected })
    groups.set(key, group)
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    groupKey: modelGroupKey(group.providerId, group.items[0]?.id),
    providerId: group.providerId,
    providerName: group.providerName,
    connected: group.items.some((item) => item.connected !== false),
    defaults: {},
    items: group.items,
  }))
}

function queryModelSource(selection: HarnessSelection, query: UseQueryResult<HarnessOptions>): Accessor<ModelSource> {
  return createMemo((): ModelSource => {
    if (query.error) return { kind: "failed", reason: toAppError(query.error).message }
    if (query.isPending) return { kind: "loading" }
    return { kind: "ready", groups: harnessGroups(selection, query.data?.models?.choices ?? []) }
  })
}

export function useConnectionModelSource(selection: HarnessSelection, placement: Accessor<ReadyPlacement>): Accessor<ModelSource> {
  const server = useServer()
  const harness = selection.kind === "native" ? selection.harnessId : selection.connectionId
  return queryModelSource(selection, useQuery(() => server.queries.harnesses.options(placement().placementId, harness)))
}

export function useAccountModelSource(harness: HarnessId): Accessor<ModelSource> {
  const server = useServer()
  return queryModelSource(nativeHarness(harness), useQuery(() => server.queries.harnesses.catalogOptions(harness)))
}

function usePiModels(): Accessor<ModelSource> {
  const server = useServer()
  const catalog = createProviderCatalog({ server, harness: () => "pi", eager: true })
  return createMemo((): ModelSource => {
    const reason = catalog.error()
    if (reason) return { kind: "failed", reason }
    return catalog.resolved() ? { kind: "ready", groups: harnessGroups(nativeHarness("pi"), piModelChoices(catalog.connected())) } : { kind: "loading" }
  })
}

function useOpenCodeModels(): Accessor<ModelSource> {
  const server = useServer()
  const catalog = createProviderCatalog({ server, harness: () => "opencode", eager: true })
  const [hydrating, setHydrating] = createSignal(true)
  const providers = createMemo(() => catalogProviders([...catalog.all().values()], catalog.connected().map((item) => item.id), "", []))
  let hydrated = ""
  createEffect(() => {
    const ids = providers().map((provider) => provider.id)
    const key = ids.join(",")
    if (!key) {
      if (!catalog.loading()) setHydrating(false)
      return
    }
    if (key === hydrated) return
    hydrated = key
    setHydrating(true)
    void Promise.allSettled(ids.map((id) => catalog.load(id))).finally(() => setHydrating(false))
  })
  return createMemo((): ModelSource => {
    const connected = new Set(catalog.connected().map((item) => item.id))
    const groups = providers()
      .filter((provider) => Object.keys(provider.models).length > 0)
      .map((provider) => ({
        key: provider.id,
        groupKey: provider.id,
        providerId: provider.id,
        providerName: provider.name,
        connected: connected.has(provider.id),
        defaults: catalog.default(),
        items: Object.values(provider.models).map((model) => ({ id: model.id, name: model.name.replace("(latest)", "").trim(), provider: { id: provider.id, name: provider.name } })),
      }))
    const reason = catalog.error()
    if (reason) return { kind: "failed", reason }
    return !catalog.resolved() || (hydrating() && groups.length === 0) ? { kind: "loading" } : { kind: "ready", groups }
  })
}

export function useCatalogModelSource(harness: "pi" | "opencode"): Accessor<ModelSource> {
  return harness === "pi" ? usePiModels() : useOpenCodeModels()
}

