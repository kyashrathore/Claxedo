import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Switch } from "@opencode-ai/ui/switch"
import { Tag } from "@opencode-ai/ui/tag"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { createEffect, createMemo, createSignal, type Component, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/platform/i18n/provider"
import { groupHarnessModels, useModelVisibility, useProviders } from "@/features/settings/app-ports"
import { useHarnessModelOptions } from "@/features/settings/harness-models"
import { popularProviders } from "@/platform/query/provider-list"
import { SettingsList } from "./list"
import { useSettingsScope, type SettingsHarnessOption } from "@/features/settings/scope/settings-scope"
import {
  MODELS_PREVIEW_COUNT,
  providerUsesInlineSearch,
  settingsModelCatalogProviders,
  visibleModelsForProvider,
} from "./models-settings-logic"
import { isCatalogHarnessId } from "@/platform/identity/harness-selection"
import "./models.css"

type ModelItem = {
  id: string
  name: string
  provider: { id: string; name: string }
}

/** One provider's models under one harness, with the catalog defaults that decide its unmarked rows. */
type SourceGroup = {
  key: string
  providerId: string
  providerName: string
  connected: boolean
  items: ModelItem[]
  defaults: Record<string, string>
}

/** What one harness reports for the workspace in view, published by its source component. */
type SourceState = {
  option: SettingsHarnessOption
  loading: boolean
  error?: string
  /** True when the harness answered and simply has nothing. */
  empty: boolean
  groups: SourceGroup[]
}

type EnabledRow = ModelItem & { group: SourceGroup }

function modelKeyOf(item: ModelItem) {
  return { providerID: item.provider.id, modelID: item.id }
}

/**
 * Reads one harness's models and publishes them upward. OpenCode's come from
 * the provider catalog; every other harness reports its own list through its
 * options endpoint, the same answer the composer's picker shows. Renders
 * nothing: the page draws the ledger and the browser from every source at once.
 */
const HarnessModelSource: Component<{ option: SettingsHarnessOption; publish: (state: SourceState) => void }> = (props) => {
  const scope = useSettingsScope()
  const catalogHarnessId = () => {
    const selection = props.option.selection
    return selection.kind === "native" && isCatalogHarnessId(selection.harnessId) ? selection.harnessId : undefined
  }
  const usesCatalog = () => catalogHarnessId() !== undefined
  const providers = useProviders(() => catalogHarnessId() ?? "", scope.scopeRef)
  const harnessModels = useHarnessModelOptions({
    serverUrl: scope.serverUrl,
    directory: () => scope.workspace()?.directory,
    harness: () => props.option.selection,
    enabled: () => !usesCatalog(),
  })
  const [hydrating, setHydrating] = createSignal(true)
  const [hydrateKey, setHydrateKey] = createSignal("")

  // The catalog rows this source is about, named before their model sets
  // exist: the boot catalog is an index, so a disconnected provider carries no
  // models until the hydration below fetches its detail.
  const catalogProviders = createMemo(() =>
    settingsModelCatalogProviders({
      all: [...providers.all().values()],
      connectedIds: providers.connected().map((item) => item.id),
      popularProviders,
    }))

  createEffect(() => {
    if (!usesCatalog()) {
      setHydrating(false)
      return
    }
    const providerIds = catalogProviders().map((provider) => provider.id)
    const key = providerIds.join(",")
    if (!key) {
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

  const groups = createMemo<SourceGroup[]>(() => {
    if (!usesCatalog()) {
      return groupHarnessModels(props.option.selection, harnessModels.data ?? []).map((group) => ({
        key: group.key,
        providerId: group.providerId,
        providerName: group.providerName,
        connected: true,
        defaults: {},
        items: group.items.map((model) => ({
          id: model.id,
          name: model.name,
          provider: { id: group.providerId, name: group.providerName },
        })),
      }))
    }
    const connectedIds = new Set(providers.connected().map((item) => item.id))
    const defaults = providers.default()
    return catalogProviders()
      .filter((provider) => Object.keys(provider.models).length > 0)
      .map((provider) => ({
        key: provider.id,
        providerId: provider.id,
        providerName: provider.name,
        connected: connectedIds.has(provider.id),
        defaults,
        items: Object.values(provider.models).map((model) => ({
          id: model.id,
          name: model.name.replace("(latest)", "").trim(),
          provider: { id: provider.id, name: provider.name },
        })),
      }))
  })

  createEffect(() => {
    const loading = usesCatalog()
      ? providers.loading() || hydrating()
      : harnessModels.isPending && harnessModels.fetchStatus !== "idle"
    const error = usesCatalog()
      ? providers.error()
      : harnessModels.error instanceof Error ? harnessModels.error.message : undefined
    props.publish({
      option: props.option,
      loading,
      ...(error ? { error } : {}),
      empty: !loading && !error && groups().length === 0,
      groups: groups(),
    })
  })

  return null
}

const ProviderModelList: Component<{
  entry: SourceGroup
  visible: (key: { providerID: string; modelID: string }) => boolean
  setVisibility: (key: { providerID: string; modelID: string }, checked: boolean) => void
}> = (props) => {
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  const useSearch = () => providerUsesInlineSearch(props.entry.items.length, false)
  const visibleItems = createMemo(() =>
    visibleModelsForProvider({ items: props.entry.items, query: query(), pageFilterActive: false }),
  )

  return (
    <div class="flex flex-col gap-2">
      <Show when={useSearch()}>
        <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base">
          <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
          <TextField
            variant="ghost"
            type="text"
            value={query()}
            onChange={setQuery}
            placeholder={language.t("settings.models.providerSearch.placeholder", { provider: props.entry.providerName })}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            class="flex-1"
            data-action="settings-models-model-search"
          />
          <Show when={query()}>
            <IconButton icon="circle-x" variant="ghost" onClick={() => setQuery("")} />
          </Show>
        </div>
        <Show when={!query().trim()}>
          <p class="text-12-regular text-text-weak px-0.5">
            {language.t("settings.models.providerSearch.hint", {
              shown: String(MODELS_PREVIEW_COUNT),
              total: String(props.entry.items.length),
            })}
          </p>
        </Show>
        <Show when={query().trim() && visibleItems().length === 0}>
          <p class="text-12-regular text-text-weak px-0.5">
            {language.t("settings.models.providerSearch.empty", { query: query().trim() })}
          </p>
        </Show>
      </Show>
      <SettingsList>
        <For each={visibleItems()}>
          {(item) => {
            const key = modelKeyOf(item)
            return (
              <div
                class="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none"
                data-component="models-browse-row"
              >
                <span class="text-14-regular text-text-strong truncate">{item.name}</span>
                <Switch checked={props.visible(key)} onChange={(checked) => props.setVisibility(key, checked)} hideLabel>
                  {item.name}
                </Switch>
              </div>
            )
          }}
        </For>
      </SettingsList>
    </div>
  )
}

function matchesFilter(item: ModelItem, query: string) {
  return !query
    || item.name.toLowerCase().includes(query)
    || item.id.toLowerCase().includes(query)
    || item.provider.name.toLowerCase().includes(query)
}

/**
 * One harness. Its enabled models come first, the provider named inline when
 * the harness offers more than one. Below them, the rest of what it reports:
 * a harness with several providers asks for a provider before showing models,
 * a harness with one list shows the models it does not yet offer.
 */
const HarnessSection: Component<{ source: SourceState; filter: string }> = (props) => {
  const language = useLanguage()
  const scope = useSettingsScope()
  const visibility = useModelVisibility()
  const [providerQuery, setProviderQuery] = createSignal("")
  const [pinned, setPinned] = createSignal<string | undefined>()
  const query = () => props.filter.trim().toLowerCase()
  const multiProvider = () => props.source.groups.length > 1

  const enabled = createMemo<EnabledRow[]>(() =>
    props.source.groups.flatMap((group) =>
      group.items
        .filter((item) => visibility.visible(modelKeyOf(item), group.defaults) && matchesFilter(item, query()))
        .map((item) => ({ ...item, group }))))

  /** For a single-list harness: what it reports that is not switched on. */
  const available = createMemo<SourceGroup | undefined>(() => {
    const group = props.source.groups[0]
    if (!group || multiProvider()) return undefined
    const items = group.items.filter((item) => !visibility.visible(modelKeyOf(item), group.defaults) && matchesFilter(item, query()))
    return { ...group, items }
  })

  const matchingProviders = createMemo(() => {
    const needle = providerQuery().trim().toLowerCase()
    return props.source.groups.filter((group) => !needle || group.providerName.toLowerCase().includes(needle))
  })
  const pinnedGroup = createMemo(() => props.source.groups.find((group) => group.key === pinned()))

  const note = () => {
    if (props.source.loading) return `${language.t("common.loading")}${language.t("common.loading.ellipsis")}`
    if (props.source.error) return props.source.error
    if (props.source.empty) {
      return language.t("settings.models.harness.empty", { harness: props.source.option.label, workspace: scope.workspace()?.label ?? "" })
    }
    return undefined
  }

  const hidden = () => !!query() && !props.source.loading && enabled().length === 0 && (available()?.items.length ?? 0) === 0

  return (
    <Show when={!hidden()}>
      <section class="flex flex-col gap-4" data-component={`models-section-${props.source.option.slug}`}>
        <div class="flex items-baseline justify-between gap-4">
          <div class="flex items-center gap-2">
            <ProviderIcon id={props.source.option.slug} class="size-4 shrink-0 icon-strong-base" />
            <h3 class="text-14-medium text-text-strong">{props.source.option.label}</h3>
          </div>
          <span class="text-12-regular text-text-weak tabular-nums">
            {language.t("settings.models.enabled.count", { count: String(enabled().length) })}
          </span>
        </div>

        <Show when={note()}>
          {(text) => (
            <p class="text-12-regular text-text-weak" data-component={`models-source-note-${props.source.option.slug}`}>{text()}</p>
          )}
        </Show>

        <Show when={enabled().length > 0}>
          <SettingsList>
            <For each={enabled()}>
              {(row, index) => (
                <div
                  class="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none"
                  data-component="models-enabled-row"
                  style={{ "--row-index": String(index()) }}
                >
                  <span class="min-w-0 flex items-baseline gap-2 truncate">
                    <Show when={multiProvider()}>
                      <span class="text-13-regular text-text-weak shrink-0">{row.provider.name} ·</span>
                    </Show>
                    <span class="text-14-regular text-text-strong truncate">{row.name}</span>
                  </span>
                  <Switch checked onChange={(checked) => visibility.setVisibility(modelKeyOf(row), checked)} hideLabel>
                    {row.name}
                  </Switch>
                </div>
              )}
            </For>
          </SettingsList>
        </Show>
        <Show when={enabled().length === 0 && !note() && !query()}>
          <p class="text-12-regular text-text-weak" data-component="models-enabled-empty">
            {language.t("settings.models.enabled.empty")}
          </p>
        </Show>

        <Show when={multiProvider()}>
          <div class="flex flex-col gap-3 pt-1" data-component="models-browse">
            <span class="text-12-regular text-text-weak">{language.t("settings.models.add.title")}</span>
            <Show
              when={pinnedGroup()}
              fallback={(
                <>
                  <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base">
                    <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
                    <TextField
                      variant="ghost"
                      type="text"
                      value={providerQuery()}
                      onChange={setProviderQuery}
                      placeholder={language.t("settings.models.add.providerSearch")}
                      spellcheck={false}
                      autocorrect="off"
                      autocomplete="off"
                      autocapitalize="off"
                      class="flex-1"
                      data-action="settings-models-provider-search"
                    />
                    <Show when={providerQuery()}>
                      <IconButton icon="circle-x" variant="ghost" onClick={() => setProviderQuery("")} />
                    </Show>
                  </div>
                  <div class="flex flex-wrap gap-2" data-component="models-provider-chips">
                    <For each={matchingProviders()}>
                      {(group) => (
                        <button
                          type="button"
                          class="flex items-center gap-2 rounded-full border border-border-weak-base bg-surface-base px-3 py-1.5 text-13-regular text-text-strong hover:border-border-strong-base hover:bg-surface-base-hover"
                          data-component="models-provider-chip"
                          data-provider={group.providerId}
                          data-harness={props.source.option.slug}
                          onClick={() => setPinned(group.key)}
                        >
                          <ProviderIcon id={group.providerId} class="size-4 shrink-0 icon-strong-base" />
                          <span>{group.providerName}</span>
                          <span class="text-12-regular text-text-weak tabular-nums">{group.items.length}</span>
                        </button>
                      )}
                    </For>
                  </div>
                  <Show when={providerQuery().trim() && matchingProviders().length === 0}>
                    <p class="text-12-regular text-text-weak">
                      {language.t("settings.models.add.noProviders", { query: providerQuery().trim() })}
                    </p>
                  </Show>
                </>
              )}
            >
              {(group) => (
                <div class="flex flex-col gap-3" data-component="models-pinned-provider">
                  <div class="flex items-center gap-3">
                    <IconButton
                      icon="chevron-left"
                      variant="ghost"
                      aria-label={language.t("settings.models.add.back")}
                      data-action="settings-models-unpin"
                      onClick={() => setPinned(undefined)}
                    />
                    <ProviderIcon id={group().providerId} class="size-5 shrink-0 icon-strong-base" />
                    <span class="text-14-medium text-text-strong truncate">{group().providerName}</span>
                    <Show when={!group().connected}>
                      <Tag>{language.t("settings.providers.status.notConnected")}</Tag>
                    </Show>
                  </div>
                  <ProviderModelList
                    entry={group()}
                    visible={(key) => visibility.visible(key, group().defaults)}
                    setVisibility={visibility.setVisibility}
                  />
                </div>
              )}
            </Show>
          </div>
        </Show>

        <Show when={available()?.items.length}>
          <div class="flex flex-col gap-3 pt-1" data-component="models-browse">
            <span class="text-12-regular text-text-weak">{language.t("settings.models.add.title")}</span>
            <ProviderModelList
              entry={available()!}
              visible={(key) => visibility.visible(key, available()!.defaults)}
              setVisibility={visibility.setVisibility}
            />
          </div>
        </Show>
      </section>
    </Show>
  )
}

export const SettingsModels: Component = () => {
  const language = useLanguage()
  const scope = useSettingsScope()
  const [sources, setSources] = createStore<Record<string, SourceState>>({})
  const [filter, setFilter] = createSignal("")

  const ordered = createMemo(() =>
    scope.harnesses().flatMap((option) => {
      const state = sources[option.slug]
      return state ? [state] : []
    }))

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar bg-inherit px-4 pb-10 sm:px-10 sm:pb-10">
      <Show when={scope.workspace()}>
        <For each={scope.harnesses()}>
          {(option) => <HarnessModelSource option={option} publish={(state) => setSources(option.slug, state)} />}
        </For>
      </Show>

      <div class="sticky top-0 z-10 bg-inherit">
        <div class="flex flex-col gap-4 pt-6 pb-6 max-w-[720px]">
          <div class="flex flex-col gap-1">
            <h2 class="text-18-medium text-text-strong">{language.t("settings.models.title")}</h2>
            <p class="text-12-regular text-text-weak">{language.t("settings.models.description")}</p>
          </div>
          <div class="flex items-center gap-2 px-3 h-9 rounded-lg bg-surface-base">
            <Icon name="magnifying-glass" class="text-icon-weak-base flex-shrink-0" />
            <TextField
              variant="ghost"
              type="text"
              value={filter()}
              onChange={setFilter}
              placeholder={language.t("dialog.model.search.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              class="flex-1"
              data-action="settings-models-search"
            />
            <Show when={filter()}>
              <IconButton icon="circle-x" variant="ghost" onClick={() => setFilter("")} />
            </Show>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-10 max-w-[720px]">
        <Show
          when={scope.workspace()}
          fallback={(
            <p class="text-12-regular text-text-weak" data-component="models-no-workspace">
              {scope.loading()
                ? language.t("settings.scope.workspace.loading")
                : language.t("settings.scope.workspace.empty")}
            </p>
          )}
        >
          <For each={ordered()}>
            {(source) => <HarnessSection source={source} filter={filter()} />}
          </For>
        </Show>
      </div>
    </div>
  )
}
