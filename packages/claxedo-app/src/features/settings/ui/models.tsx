import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Switch } from "@opencode-ai/ui/switch"
import { Tag } from "@opencode-ai/ui/tag"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { TextField } from "@opencode-ai/ui/text-field"
import { createEffect, createMemo, createSignal, type Component, For, type JSX, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/platform/i18n/provider"
import { groupHarnessModels, useModelVisibility, useProviders } from "@/features/settings/app-ports"
import { useHarnessModelOptions } from "@/features/settings/harness-models"
import { SettingsEmpty, SettingsList } from "@/ui/controls/settings-list"
import { useSettingsScope, type SettingsHarnessOption } from "@/features/settings/scope/settings-scope"
import {
  catalogNeedsSearch,
  modelGroupKey,
  MODELS_PREVIEW_COUNT,
  providerUsesInlineSearch,
  settingsCatalogProviders,
  visibleModelsForProvider,
} from "./settings-catalog-rules"
import { isCatalogHarnessId, type NativeHarnessId } from "@/platform/identity/harness-selection"
import { MachineAccountsProvider } from "@/features/settings/machine-accounts"
import { AgentHarnessAccounts, MachineScanStatus, machineHarnessFor } from "@/features/settings/ui/agents-section"
import { HarnessProvidersSection } from "@/features/settings/ui/harness-providers-section"
import "./models.css"

type ModelItem = {
  id: string
  name: string
  provider: { id: string; name: string }
  /** False when the harness names a model it holds no credential for. */
  connected?: boolean
}

/** One provider's models under one harness, with the catalog defaults that decide its unmarked rows. */
type SourceGroup = {
  key: string
  /** Where this group's enable-all answer is stored. */
  groupKey: string
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

function modelKeyOf(item: ModelItem) {
  return { providerID: item.provider.id, modelID: item.id }
}

/**
 * Reads one harness's models and publishes them upward. OpenCode's come from
 * the provider catalog; every other harness reports its own list through its
 * options endpoint, the same answer the composer's picker shows. Renders
 * nothing: the page draws every source at once.
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

  // Only connected providers are hydrated: the boot catalog is an index, and a
  // provider the user never connected has nothing to enable, so fetching its
  // model detail spends 180 requests to fill a list this page does not draw.
  const catalogProviders = createMemo(() =>
    settingsCatalogProviders({
      all: [...providers.all().values()],
      connectedIds: providers.connected().map((item) => item.id),
      popularProviders: [],
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
      return groupHarnessModels(props.option.selection, harnessModels.data ?? []).map((group) => {
        const items = group.items.map((model) => ({
          id: model.id,
          name: model.name,
          provider: { id: group.providerId, name: group.providerName },
          ...(model.connected === undefined ? {} : { connected: model.connected }),
        }))
        return {
          key: group.key,
          groupKey: modelGroupKey({ providerId: group.providerId, sampleModelId: items[0]?.id }),
          providerId: group.providerId,
          providerName: group.providerName,
          connected: items.some((item) => item.connected !== false),
          defaults: {},
          items,
        }
      })
    }
    const connectedIds = new Set(providers.connected().map((item) => item.id))
    const defaults = providers.default()
    return catalogProviders()
      .filter((provider) => Object.keys(provider.models).length > 0)
      .map((provider) => ({
        key: provider.id,
        groupKey: provider.id,
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


/** Which native harness a section is about, where it is one at all. */
function nativeHarnessOf(option: SettingsHarnessOption): NativeHarnessId | undefined {
  return option.selection.kind === "native" ? option.selection.harnessId : undefined
}

/**
 * The logins one harness runs on.
 *
 * Three different answers behind one tab, because the question is the same and
 * the user should not have to know which kind of harness they are looking at:
 * a CLI harness holds its own accounts on this machine, a catalog harness is
 * connected provider by provider, and an operator connection carries neither.
 */
const HarnessAccounts: Component<{
  option: SettingsHarnessOption
  onAddAccountRef?: (open: () => void) => void
}> = (props) => {
  const language = useLanguage()
  const machine = () => machineHarnessFor(nativeHarnessOf(props.option) ?? "")
  const native = () => nativeHarnessOf(props.option)
  return (
    <Show
      when={machine()}
      fallback={(
        <Show
          when={native()}
          fallback={(
            <SettingsEmpty>
              <span data-component="models-accounts-external">
                {language.t("settings.models.accounts.connection", { harness: props.option.label })}
              </span>
            </SettingsEmpty>
          )}
        >
          {(harness) => (
            <HarnessProvidersSection
              harness={harness()}
              {...(props.onAddAccountRef ? { onAddCustomRef: props.onAddAccountRef } : {})}
            />
          )}
        </Show>
      )}
    >
      {(harness) => (
        <AgentHarnessAccounts
          harness={harness()}
          headerless
          {...(props.onAddAccountRef ? { onAddAccountRef: props.onAddAccountRef } : {})}
        />
      )}
    </Show>
  )
}

type HarnessTab = "accounts" | "models"

/**
 * Accounts or models for one harness; the two halves of the same question.
 *
 * Which one is open is the page's to hold, not this component's: a harness
 * source publishes several times while it loads, each publish replaces its row
 * in the store, and the row is recreated — a tab signal owned here was
 * discarded mid-read and the section snapped back to Accounts under the user.
 */
const HarnessTabs: Component<{
  option: SettingsHarnessOption
  tab: HarnessTab
  onTab: (tab: HarnessTab) => void
  /** Drawn on the tab row, where the surface's own heading is. */
  actions?: JSX.Element
  children: (tab: HarnessTab) => JSX.Element
}> = (props) => {
  const language = useLanguage()
  const tab = () => props.tab
  const setTab = (next: HarnessTab) => props.onTab(next)
  const tabs = ["accounts", "models"] as const
  return (
    <div class="flex flex-col gap-4">
      <div class="flex items-center gap-1" role="tablist" data-component="models-harness-tabs">
        <For each={tabs}>
          {(value) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab() === value}
              class="rounded-md px-2.5 py-1 text-13-regular"
              classList={{
                "text-text-strong bg-surface-base": tab() === value,
                "text-text-weak": tab() !== value,
              }}
              data-action={`settings-models-tab-${value}`}
              onClick={() => setTab(value)}
            >
              {language.t(`settings.models.tab.${value}`)}
            </button>
          )}
        </For>
        <span class="flex-1" />
        {props.actions}
      </div>
      {props.children(tab())}
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
 * One provider's models, opened from its group row. The group answer is the
 * control that matters — this is for the provider whose registry entry the
 * user wants to differ from it.
 */
const ProviderModelList: Component<{
  entry: SourceGroup
  pageFilter: string
  visible: (item: ModelItem) => boolean
  setVisibility: (item: ModelItem, checked: boolean) => void
}> = (props) => {
  const language = useLanguage()
  const [query, setQuery] = createSignal("")
  const pageFilterActive = () => !!props.pageFilter.trim()
  const matched = createMemo(() =>
    props.entry.items.filter((item) => matchesFilter(item, props.pageFilter.trim().toLowerCase())))
  const useSearch = () => providerUsesInlineSearch(matched().length, pageFilterActive())
  const visibleItems = createMemo(() =>
    visibleModelsForProvider({ items: matched(), query: query(), pageFilterActive: pageFilterActive() }),
  )

  return (
    <div class="flex flex-col gap-2" data-component="models-group-models">
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
              total: String(matched().length),
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
          {(item) => (
            <div
              class="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none"
              data-component="models-browse-row"
            >
              <span class="text-14-regular text-text-strong truncate">{item.name}</span>
              <Switch checked={props.visible(item)} onChange={(checked) => props.setVisibility(item, checked)} hideLabel>
                {item.name}
              </Switch>
            </div>
          )}
        </For>
      </SettingsList>
    </div>
  )
}

/**
 * One provider under one harness: a heading with what it offers, and its
 * models under it.
 *
 * Open when anything of its is on, because a provider the user is already
 * running is one they came here to adjust; a provider with nothing on stays
 * shut and is opened by its heading.
 */
/** One group's models with no heading, for a harness that is its own provider. */
const GroupModels: Component<{ entry: SourceGroup; pageFilter: string }> = (props) => {
  const visibility = useModelVisibility()
  const context = (item: ModelItem) => ({
    defaults: props.entry.defaults,
    group: props.entry.groupKey,
    ...(item.connected === undefined ? {} : { connected: item.connected }),
  })
  return (
    <ProviderModelList
      entry={props.entry}
      pageFilter={props.pageFilter}
      visible={(item) => visibility.visible(modelKeyOf(item), context(item))}
      setVisibility={(item, checked) => visibility.setVisibility(modelKeyOf(item), checked)}
    />
  )
}

const GroupRow: Component<{ entry: SourceGroup; pageFilter: string }> = (props) => {
  const language = useLanguage()
  const visibility = useModelVisibility()
  const [override, setOverride] = createSignal<boolean>()

  const context = (item: ModelItem) => ({
    defaults: props.entry.defaults,
    group: props.entry.groupKey,
    ...(item.connected === undefined ? {} : { connected: item.connected }),
  })
  const isVisible = (item: ModelItem) => visibility.visible(modelKeyOf(item), context(item))
  const enabled = createMemo(() => props.entry.items.filter(isVisible).length)
  const open = () => override() ?? enabled() > 0

  return (
    <div class="flex flex-col" data-component="models-group" data-provider={props.entry.providerId} data-group={props.entry.groupKey}>
      <div
        class="flex w-full items-center gap-2 rounded-md bg-surface-base px-2.5 py-1.5"
        data-component="models-group-row"
      >
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 border-none bg-transparent text-left"
          data-action="settings-models-group-expand"
          aria-expanded={open()}
          onClick={() => setOverride(!open())}
        >
          <ProviderIcon id={props.entry.providerId} class="size-4 shrink-0 icon-strong-base" />
          <span class="min-w-0 flex-1 truncate text-compact text-text-base">{props.entry.providerName}</span>
        </button>
        <Show when={!props.entry.connected}>
          <Tag>{language.t("settings.providers.status.notConnected")}</Tag>
        </Show>
        <span class="shrink-0 text-12-regular tabular-nums text-text-weak">
          {language.t("settings.models.group.count", {
            enabled: String(enabled()),
            total: String(props.entry.items.length),
          })}
        </span>
        {/* Worded, not a switch: a toggle beside a provider's name reads as
            "turn this provider off", and what it does is turn its models off. */}
        <button
          type="button"
          class="shrink-0 rounded-md border-none bg-transparent px-1 py-0.5 text-12-regular text-text-interactive-base"
          data-action="settings-models-group-toggle-all"
          onClick={() =>
            visibility.setGroupVisibility(props.entry.groupKey, enabled() === 0, props.entry.items.map(modelKeyOf))}
        >
          {language.t(enabled() === 0 ? "settings.models.group.enableAll" : "settings.models.group.disableAll")}
        </button>
      </div>
      <Show when={open()}>
        <ProviderModelList
          entry={props.entry}
          pageFilter={props.pageFilter}
          visible={isVisible}
          setVisibility={(item, checked) => visibility.setVisibility(modelKeyOf(item), checked)}
        />
      </Show>
    </div>
  )
}

/**
 * One harness. Its providers, connected ones first, each answering for its own
 * models. Providers the harness names but holds no credential for are reached
 * by search rather than listed: Pi names ~1350 models across vendors it cannot
 * currently run.
 */
const HarnessSection: Component<{
  source: SourceState
  filter: string
  tab: HarnessTab
  onTab: (tab: HarnessTab) => void
}> = (props) => {
  const language = useLanguage()
  const visibility = useModelVisibility()
  const [addAccount, setAddAccount] = createSignal<() => void>()
  const query = () => props.filter.trim().toLowerCase()

  const enabledCount = createMemo(() =>
    props.source.groups.reduce((total, group) => total + group.items.filter((item) =>
      visibility.visible(modelKeyOf(item), {
        defaults: group.defaults,
        group: group.groupKey,
        ...(item.connected === undefined ? {} : { connected: item.connected }),
      })).length, 0))

  // The page search is a model search, so a harness with no matching model
  // drops out of it entirely rather than standing as an empty heading.
  const hidden = () =>
    !!query()
    && !props.source.loading
    && !props.source.groups.some((group) => group.items.some((item) => matchesFilter(item, query())))

  return (
    <Show when={!hidden()}>
      <section class="flex flex-col gap-4" data-component={`models-section-${props.source.option.slug}`}>
        <div class="flex items-baseline justify-between gap-4">
          <div class="flex items-center gap-2">
            <ProviderIcon id={props.source.option.slug} class="size-4 shrink-0 icon-strong-base" />
            <h3 class="text-14-medium text-text-strong">{props.source.option.label}</h3>
          </div>
          <span class="text-12-regular text-text-weak tabular-nums">
            {language.t("settings.models.enabled.count", { count: String(enabledCount()) })}
          </span>
        </div>

        <HarnessTabs
          option={props.source.option}
          tab={props.tab}
          onTab={props.onTab}
          actions={(
            <>
              <Show when={props.tab === "accounts" && addAccount()}>
                {(open) => (
                  <button
                    type="button"
                    class="rounded-md border-none bg-transparent px-1 py-0.5 text-12-regular text-text-interactive-base"
                    data-action="agent-add-account"
                    onClick={() => open()()}
                  >
                    {nativeHarnessOf(props.source.option) === "opencode"
                      ? language.t("provider.custom.title")
                      : language.t("settings.providers.agents.addAccount")}
                  </button>
                )}
              </Show>
              <Show when={props.tab === "models" ? soleSelfGroup(props.source) : undefined}>
                {(group) => (
                  <button
                    type="button"
                    class="rounded-md border-none bg-transparent px-1 py-0.5 text-12-regular text-text-interactive-base"
                    data-action="settings-models-group-toggle-all"
                    onClick={() =>
                      visibility.setGroupVisibility(
                        group().groupKey,
                        enabledCount() === 0,
                        group().items.map(modelKeyOf),
                      )}
                  >
                    {language.t(enabledCount() === 0 ? "settings.models.group.enableAll" : "settings.models.group.disableAll")}
                  </button>
                )}
              </Show>
            </>
          )}
        >
          {(tab) => (
            <Show
              when={tab === "models"}
              fallback={<HarnessAccounts option={props.source.option} onAddAccountRef={(open) => setAddAccount(() => open)} />}
            >
              <ModelsTab source={props.source} filter={props.filter} />
            </Show>
          )}
        </HarnessTabs>
      </section>
    </Show>
  )
}

/**
 * Whether a harness IS its only provider, in which case naming it again above
 * its own models says nothing: Claude Code offers Claude Code's models.
 *
 * Read off the group key, not the provider id. Pi reports every vendor under
 * its own provider id, so a workspace where it can reach one vendor would
 * otherwise look like a harness that is its own provider and lose the vendor's
 * name — the one thing that row is there to say.
 */
function soleSelfGroup(source: SourceState) {
  const [group, ...rest] = source.groups
  return rest.length === 0 && group && group.groupKey === source.option.slug ? group : undefined
}

/** The models half of one harness section: its providers, and what each offers. */
const ModelsTab: Component<{ source: SourceState; filter: string }> = (props) => {
  const language = useLanguage()
  const scope = useSettingsScope()
  const [providerQuery, setProviderQuery] = createSignal("")
  const query = () => props.filter.trim().toLowerCase()

  const groups = createMemo(() =>
    settingsCatalogProviders({
      // Searched by group key, not by display name: Pi's names are derived
      // from the model-id prefix with the separators spelled out ("Amazon
      // Bedrock"), so the id the user reads in a model row matches nothing.
      all: props.source.groups.map((group) => ({ ...group, id: group.groupKey, name: group.providerName })),
      connectedIds: props.source.groups.filter((group) => group.connected).map((group) => group.groupKey),
      popularProviders: [],
      query: providerQuery(),
    }).filter((group) => !query() || group.items.some((item) => matchesFilter(item, query()))))

  const note = () => {
    if (props.source.loading) return `${language.t("common.loading")}${language.t("common.loading.ellipsis")}`
    if (props.source.error) return props.source.error
    if (props.source.empty) {
      return language.t("settings.models.harness.empty", { harness: props.source.option.label, workspace: scope.workspace()?.label ?? "" })
    }
    return undefined
  }

  return (
    <>
        <Show when={note()}>
          {(text) => (
            <SettingsEmpty>
              <span data-component={`models-source-note-${props.source.option.slug}`}>{text()}</span>
            </SettingsEmpty>
          )}
        </Show>

        <Show when={catalogNeedsSearch(props.source.groups.length)}>
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
        </Show>

        <Show when={soleSelfGroup(props.source)}>
          {(group) => (
            <GroupModels entry={group()} pageFilter={props.filter} />
          )}
        </Show>

        <Show when={!soleSelfGroup(props.source) && groups().length > 0} fallback={(
          <Show when={!note() && !soleSelfGroup(props.source)}>
            <SettingsEmpty>
              <span data-component="models-enabled-empty">
                {providerQuery().trim()
                  ? language.t("settings.models.add.noProviders", { query: providerQuery().trim() })
                  : language.t("settings.models.enabled.empty")}
              </span>
            </SettingsEmpty>
          </Show>
        )}>
          <div class="flex flex-col">
            <For each={groups()}>
              {(group) => <GroupRow entry={group} pageFilter={props.filter} />}
            </For>
          </div>
        </Show>
    </>
  )
}

export const SettingsModels: Component = () => {
  const language = useLanguage()
  const scope = useSettingsScope()
  const [sources, setSources] = createStore<Record<string, SourceState>>({})
  const [tabs, setTabs] = createStore<Record<string, HarnessTab>>({})

  const ordered = createMemo(() =>
    scope.harnesses().flatMap((option) => {
      const state = sources[option.slug]
      return state ? [state] : []
    }))

  return (
    <MachineAccountsProvider>
    <div class="flex flex-col bg-inherit pb-10" data-component="settings-models-page">
      <Show when={scope.workspace()}>
        <For each={scope.harnesses()}>
          {(option) => <HarnessModelSource option={option} publish={(state) => setSources(option.slug, state)} />}
        </For>
      </Show>

      {/* The one line the page keeps: when this machine was last asked what
          it is signed in to, which is what every Accounts tab below reports. */}
      <div class="pb-6">
        <MachineScanStatus />
      </div>

      <div class="flex flex-col gap-10">
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
            {(source) => (
              <HarnessSection
                source={source}
                filter=""
                tab={tabs[source.option.slug] ?? "accounts"}
                onTab={(tab) => setTabs(source.option.slug, tab)}
              />
            )}
          </For>
        </Show>
      </div>
    </div>
    </MachineAccountsProvider>
  )
}
