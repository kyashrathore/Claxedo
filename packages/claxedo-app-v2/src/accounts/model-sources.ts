import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { createProviderCatalog, harnessModelPickerProvider, modelGroupKey } from "@/composer"
import { isCatalogHarnessId, type HarnessSelection } from "@/lib/harness-selection"
import { inCatalogOrder, primaryPlacement, useProjects } from "@/projects"
import { toAppError, useServer, type HarnessOptionChoice, type PlacementId } from "@/server"
import { catalogProviders } from "./catalog-rules"

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

export type ModelSource = { readonly loading: boolean; readonly error?: string; readonly empty: boolean; readonly groups: readonly SourceGroup[] }

export type SettingsPlacement = { readonly placementId: PlacementId; readonly label: string }

export type SettingsScope = { readonly loading: boolean; readonly placement?: SettingsPlacement }

export function useSettingsScope(): Accessor<SettingsScope> {
  const server = useServer()
  const projects = useProjects()
  return createMemo((): SettingsScope => {
    const state = projects()
    if (state.kind !== "ready") return { loading: state.kind === "loading" }
    for (const project of inCatalogOrder(state.data.filter((item) => item.available))) {
      const placement = primaryPlacement(server.placements.list(), project.id)
      if (placement) return { loading: false, placement: { placementId: placement.id, label: project.name } }
    }
    return { loading: false }
  })
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

function useHarnessModels(selection: HarnessSelection, placement: Accessor<SettingsPlacement>): Accessor<ModelSource> {
  const server = useServer()
  const harness = selection.kind === "native" ? selection.harnessId : selection.connectionId
  const query = useQuery(() => server.queries.harnesses.options(placement().placementId, harness))
  return createMemo((): ModelSource => {
    const loading = query.isPending && query.fetchStatus !== "idle"
    const error = query.error ? toAppError(query.error).message : undefined
    const groups = harnessGroups(selection, query.data?.models?.choices ?? [])
    return { loading, ...(error ? { error } : {}), empty: !loading && !error && groups.length === 0, groups }
  })
}

function useCatalogModels(harness: string): Accessor<ModelSource> {
  const server = useServer()
  const catalog = createProviderCatalog({ server, harness: () => harness, eager: true })
  const [hydrating, setHydrating] = createSignal(true)
  const providers = createMemo(() => catalogProviders([...catalog.all().values()], catalog.connected().map((item) => item.id), "", []))
  let hydrated = ""
  createEffect(() => {
    const ids = providers().map((provider) => provider.id)
    const key = ids.join(",")
    if (!key) return void (catalog.loading() || setHydrating(false))
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
    const loading = catalog.loading() || hydrating()
    const error = catalog.error()
    return { loading, ...(error ? { error } : {}), empty: !loading && !error && groups.length === 0, groups }
  })
}

export function useModelSource(selection: HarnessSelection, placement: Accessor<SettingsPlacement>): Accessor<ModelSource> {
  if (selection.kind === "native" && isCatalogHarnessId(selection.harnessId)) return useCatalogModels(selection.harnessId)
  return useHarnessModels(selection, placement)
}
