import { useFilteredList } from "@opencode-ai/ui/hooks"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Switch } from "@opencode-ai/ui/switch"
import { Tag } from "@opencode-ai/ui/tag"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { createEffect, createMemo, createSignal, on, type Component, For, Show } from "solid-js"
import { useLanguage } from "@/platform/i18n/provider"
import { useModels, useProviders } from "@/features/settings/app-ports"
import { popularProviders } from "@/platform/query/provider-list"
import { SettingsList } from "./list"
import { SettingsScopeSelector } from "@/features/settings/ui/scope-selector"
import { useSettingsScope } from "@/features/settings/scope/settings-scope"
import {
  MODELS_PREVIEW_COUNT,
  providerUsesInlineSearch,
  settingsModelCatalogProviders,
  visibleModelsForProvider,
} from "./models-settings-logic"

type ModelItem = {
  id: string
  name: string
  provider: { id: string; name: string }
  connected: boolean
}

const ListLoadingState: Component<{ label: string }> = (props) => {
  return (
    <div class="flex flex-col items-center justify-center py-12 text-center">
      <span class="text-14-regular text-text-weak">{props.label}</span>
    </div>
  )
}

const ListEmptyState: Component<{ message: string; filter: string }> = (props) => {
  return (
    <div class="flex flex-col items-center justify-center py-12 text-center">
      <span class="text-14-regular text-text-weak">{props.message}</span>
      <Show when={props.filter}>
        <span class="text-14-regular text-text-strong mt-1">&quot;{props.filter}&quot;</span>
      </Show>
    </div>
  )
}

const ProviderModelGroup: Component<{
  providerId: string
  providerName: string
  connected: boolean
  items: ModelItem[]
  /** When the page-level search is active, show the already-filtered group in full. */
  pageFilterActive: boolean
  visible: (key: { providerID: string; modelID: string }) => boolean
  setVisibility: (key: { providerID: string; modelID: string }, checked: boolean) => void
}> = (props) => {
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  const useSearch = () => providerUsesInlineSearch(props.items.length, props.pageFilterActive)

  const visibleItems = createMemo(() =>
    visibleModelsForProvider({
      items: props.items,
      query: query(),
      pageFilterActive: props.pageFilterActive,
    }),
  )

  return (
    <div class="flex flex-col gap-1">
      <div class="flex items-center justify-between gap-3 pb-2">
        <div class="flex min-w-0 items-center gap-2">
          <ProviderIcon id={props.providerId} class="size-5 shrink-0 icon-strong-base" />
          <span class="text-14-medium text-text-strong truncate">{props.providerName}</span>
        </div>
        <Show when={!props.connected}>
          <Tag>{language.t("settings.providers.status.notConnected")}</Tag>
        </Show>
      </div>

      <Show when={useSearch()}>
        <div class="flex flex-col gap-2 pb-2">
          <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base">
            <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
            <TextField
              variant="ghost"
              type="text"
              value={query()}
              onChange={setQuery}
              placeholder={language.t("settings.models.providerSearch.placeholder", {
                provider: props.providerName,
              })}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="flex-1"
            />
            <Show when={query()}>
              <IconButton icon="circle-x" variant="ghost" onClick={() => setQuery("")} />
            </Show>
          </div>
          <Show when={!query().trim()}>
            <p class="text-12-regular text-text-weak px-0.5">
              {language.t("settings.models.providerSearch.hint", {
                shown: String(MODELS_PREVIEW_COUNT),
                total: String(props.items.length),
              })}
            </p>
          </Show>
          <Show when={query().trim() && visibleItems().length === 0}>
            <p class="text-12-regular text-text-weak px-0.5">
              {language.t("settings.models.providerSearch.empty", { query: query().trim() })}
            </p>
          </Show>
        </div>
      </Show>

      <SettingsList>
        <For each={visibleItems()}>
          {(item) => {
            const key = { providerID: item.provider.id, modelID: item.id }
            return (
              <div class="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
                <div class="min-w-0">
                  <span class="text-14-regular text-text-strong truncate block">{item.name}</span>
                </div>
                <div class="flex-shrink-0">
                  <Switch
                    checked={props.visible(key)}
                    onChange={(checked) => props.setVisibility(key, checked)}
                    hideLabel
                  >
                    {item.name}
                  </Switch>
                </div>
              </div>
            )
          }}
        </For>
      </SettingsList>
    </div>
  )
}

export const SettingsModels: Component = () => {
  const language = useLanguage()
  const models = useModels()
  // The catalog of the (workspace, harness) this page is showing, read through
  // the same hook instance the hydration below writes into.
  const scope = useSettingsScope()
  const providers = useProviders(scope.harness, scope.scopeRef)
  const [hydrating, setHydrating] = createSignal(true)
  const [hydrateKey, setHydrateKey] = createSignal("")

  // The rows this page is about, named before their model sets exist: the boot
  // catalog is an index, so a disconnected provider carries no models until the
  // hydration below fetches its detail.
  const catalogProviders = createMemo(() =>
    settingsModelCatalogProviders({
      all: [...providers.all().values()],
      connectedIds: providers.connected().map((item) => item.id),
      popularProviders,
    }))

  createEffect(() => {
    const providerIds = catalogProviders().map((provider) => provider.id)
    const key = providerIds.join(",")
    if (!key) {
      // Provider index still loading.
      if (!providers.loading()) setHydrating(false)
      return
    }
    if (key === hydrateKey()) return
    setHydrateKey(key)
    setHydrating(true)
    void (async () => {
      try {
        await Promise.allSettled(providerIds.map((id) => providers.load(id)))
      } finally {
        setHydrating(false)
      }
    })()
  })

  const catalog = createMemo(() => {
    const connectedIds = new Set(providers.connected().map((item) => item.id))
    return catalogProviders().filter((provider) => Object.keys(provider.models).length > 0).flatMap((provider) =>
      Object.values(provider.models).map((model) => ({
        id: model.id,
        name: model.name.replace("(latest)", "").trim(),
        provider: { id: provider.id, name: provider.name },
        connected: connectedIds.has(provider.id),
      })),
    )
  })

  const list = useFilteredList<ModelItem>({
    items: (_filter) => catalog(),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (a, b) => a.name.localeCompare(b.name),
    groupBy: (x) => x.provider.id,
    sortGroupsBy: (a, b) => {
      const aConnected = a.items[0]?.connected === true
      const bConnected = b.items[0]?.connected === true
      if (aConnected && !bConnected) return -1
      if (!aConnected && bConnected) return 1

      const aIndex = popularProviders.indexOf(a.category)
      const bIndex = popularProviders.indexOf(b.category)
      const aPopular = aIndex >= 0
      const bPopular = bIndex >= 0

      if (aPopular && !bPopular) return -1
      if (!aPopular && bPopular) return 1
      if (aPopular && bPopular) return aIndex - bIndex

      const aName = a.items[0].provider.name
      const bName = b.items[0].provider.name
      return aName.localeCompare(bName)
    },
  })

  const harnessLabel = () =>
    scope.harnesses().find((item) => item.id === scope.harness())?.label ?? scope.harness()

  // useFilteredList's resource can settle on the boot index (one model per
  // connected provider) before detail hydration merges the full catalogs.
  const catalogModelCount = createMemo(() => catalog().length)
  createEffect(on(catalogModelCount, () => {
    void list.refetch()
  }))

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar bg-inherit px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-inherit">
        <div class="flex flex-col gap-4 pt-6 pb-6 max-w-[720px]">
          <div class="flex flex-col gap-1">
            <h2 class="text-18-medium text-text-strong">{language.t("settings.models.title")}</h2>
            <p class="text-12-regular text-text-weak">{language.t("settings.models.description")}</p>
          </div>
          <SettingsScopeSelector />
          <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base">
            <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
            <TextField
              variant="ghost"
              type="text"
              value={list.filter()}
              onChange={list.onInput}
              placeholder={language.t("dialog.model.search.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="flex-1"
            />
            <Show when={list.filter()}>
              <IconButton icon="circle-x" variant="ghost" onClick={list.clear} />
            </Show>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <Show
          when={!list.grouped.loading && !hydrating()}
          fallback={
            <ListLoadingState label={`${language.t("common.loading")}${language.t("common.loading.ellipsis")}`} />
          }
        >
          <Show
            when={list.flat().length > 0}
            fallback={(
              <ListEmptyState
                message={providers.all().size === 0
                  ? language.t("settings.providers.catalog.empty", {
                    harness: harnessLabel(),
                    workspace: scope.workspace()?.label ?? "",
                  })
                  : language.t("dialog.model.empty")}
                filter={list.filter()}
              />
            )}
          >
            <For each={list.grouped.latest}>
              {(group) => (
                <ProviderModelGroup
                  providerId={group.category}
                  providerName={group.items[0].provider.name}
                  connected={group.items[0]?.connected === true}
                  items={group.items}
                  pageFilterActive={!!list.filter().trim()}
                  visible={models.visible}
                  setVisibility={models.setVisibility}
                />
              )}
            </For>
          </Show>
        </Show>
      </div>
    </div>
  )
}
