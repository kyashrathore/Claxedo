import { createMemo, createSignal, For, Show } from "solid-js"
import { useModelVisibility } from "@/composer"
import { SettingsEmpty, SettingsList } from "@/settings"
import { Button, ClaxedoIcon, Tag, ProviderIcon } from "@/ui"
import { catalogNeedsSearch, catalogProviders, matchingModels, MODELS_PREVIEW_COUNT, usesInlineSearch } from "../catalog-rules"
import { useAccountsText } from "../i18n"
import { modelKeyOf, groupContext, type ModelItem, type ModelSource, type SourceGroup } from "../model-sources"
import { SearchField } from "./search-field"
import { ModelRows } from "./model-rows"

export function enabledCount(source: ModelSource, visible: (item: ModelItem, group: SourceGroup) => boolean): number {
  return source.groups.reduce((total, group) => total + group.items.filter((item) => visible(item, group)).length, 0)
}

export function soleSelfGroup(source: ModelSource, harness: string): SourceGroup | undefined {
  const [group, ...rest] = source.groups
  return rest.length === 0 && group && group.groupKey === harness ? group : undefined
}

function ProviderModelList(props: { readonly entry: SourceGroup }) {
  const t = useAccountsText()
  const [query, setQuery] = createSignal("")
  const [limit, setLimit] = createSignal(MODELS_PREVIEW_COUNT)
  const matches = createMemo(() => matchingModels(props.entry.items, query()))
  const items = createMemo(() => matches().slice(0, limit()))
  const search = (value: string) => {
    setQuery(value)
    setLimit(MODELS_PREVIEW_COUNT)
  }
  return (
    <>
      <div class="flex min-w-0 flex-col gap-3 py-3">
        <Show when={usesInlineSearch(props.entry.items.length)}>
          <SearchField value={query()} onChange={search} placeholder={t("settings.models.providerSearch.placeholder", { provider: props.entry.providerName })} action="settings-models-model-search" />
        </Show>
        <Show when={query().trim() && items().length === 0}>
          <p class="text-12-regular text-text-weak">{t("settings.models.providerSearch.empty", { query: query().trim() })}</p>
        </Show>
        <ModelRows entry={props.entry} items={items()} />
      </div>
      <Show when={usesInlineSearch(props.entry.items.length)}>
        <footer class="flex flex-wrap items-center justify-between gap-2 border-t border-border-weak-base py-3">
          <span class="text-12-regular text-text-weak" role="status">
            {t("settings.models.providerSearch.hint", { shown: String(items().length), total: String(matches().length) })}
          </span>
          <Show when={items().length < matches().length}>
            <Button class="min-h-11" variant="ghost" size="large" onClick={() => setLimit((count) => count + MODELS_PREVIEW_COUNT)}>
              {t("settings.models.providerSearch.loadMore", { count: String(Math.min(MODELS_PREVIEW_COUNT, matches().length - items().length)) })}
            </Button>
          </Show>
        </footer>
      </Show>
    </>
  )
}

function ProviderModelCard(props: { readonly entry: SourceGroup }) {
  const t = useAccountsText()
  const visibility = useModelVisibility()
  const enabled = createMemo(() => props.entry.items.filter((item) => visibility.visible(modelKeyOf(item), groupContext(props.entry, item))).length)
  const [open, setOpen] = createSignal(enabled() > 0)
  return (
    <section aria-label={props.entry.providerName} data-provider={props.entry.providerId} data-group={props.entry.groupKey}>
      <SettingsList>
        <header class="flex w-full flex-col border-b border-border-weak-base py-2" classList={{ "border-none": !open() }}>
          <div class="flex items-center gap-2">
            <button type="button" class="flex min-h-11 min-w-0 flex-1 items-center gap-2 border-none bg-transparent text-left" data-action="settings-models-group-expand" aria-expanded={open()} onClick={() => setOpen(!open())}>
              <ClaxedoIcon name={open() ? "chevron-down" : "chevron-right"} size="small" />
              <ProviderIcon id={props.entry.providerId} class="size-4 shrink-0 icon-strong-base" />
              <span class="min-w-0 flex-1 truncate text-compact text-text-base">{props.entry.providerName}</span>
            </button>
            <span class="shrink-0 text-12-regular tabular-nums text-text-weak">{t("settings.models.group.count", { enabled: String(enabled()), total: String(props.entry.items.length) })}</span>
            <Button class="min-h-11 shrink-0" variant="ghost" size="large" data-action="settings-models-group-toggle-all" onClick={() => visibility.setGroupVisibility(props.entry.groupKey, enabled() === 0, props.entry.items.map(modelKeyOf))}>
              {t(enabled() === 0 ? "settings.models.group.enableAll" : "settings.models.group.disableAll")}
            </Button>
          </div>
          <Show when={!props.entry.connected}>
            <div class="pb-1">
              <Tag>{t("settings.providers.status.notConnected")}</Tag>
            </div>
          </Show>
        </header>
        <Show when={open()}>
          <ProviderModelList entry={props.entry} />
        </Show>
      </SettingsList>
    </section>
  )
}

function SourceNote(props: { readonly source: ModelSource; readonly harness: string; readonly harnessLabel: string; readonly workspace: string }) {
  const t = useAccountsText()
  const text = () => {
    if (props.source.loading) return `${t("common.loading")}${t("common.loading.ellipsis")}`
    if (props.source.error) return props.source.error
    return props.source.empty ? t("settings.models.harness.empty", { harness: props.harnessLabel, workspace: props.workspace }) : undefined
  }
  return (
    <Show when={text()}>
      {(note) => (
        <SettingsEmpty>
          <span>{note()}</span>
        </SettingsEmpty>
      )}
    </Show>
  )
}

export function ModelsTab(props: { readonly source: ModelSource; readonly harness: string; readonly harnessLabel: string; readonly workspace: string }) {
  const t = useAccountsText()
  const [providerQuery, setProviderQuery] = createSignal("")
  const sole = () => soleSelfGroup(props.source, props.harness)
  const groups = createMemo(() => catalogProviders(props.source.groups.map((group) => ({ ...group, id: group.groupKey, name: group.providerName })), props.source.groups.filter((group) => group.connected).map((group) => group.groupKey), providerQuery(), []))
  const noted = () => props.source.loading || props.source.error !== undefined || props.source.empty
  return (
    <>
      <SourceNote source={props.source} harness={props.harness} harnessLabel={props.harnessLabel} workspace={props.workspace} />
      <Show when={catalogNeedsSearch(props.source.groups.length)}>
        <SearchField value={providerQuery()} onChange={setProviderQuery} placeholder={t("settings.models.add.providerSearch")} action="settings-models-provider-search" />
      </Show>
      <Show when={sole()}>
        {(group) => (
          <SettingsList>
            <ProviderModelList entry={group()} />
          </SettingsList>
        )}
      </Show>
      <Show
        when={!sole() && groups().length > 0}
        fallback={
          <Show when={!noted() && !sole()}>
            <SettingsEmpty>
              <span>{providerQuery().trim() ? t("settings.models.add.noProviders", { query: providerQuery().trim() }) : t("settings.models.enabled.empty")}</span>
            </SettingsEmpty>
          </Show>
        }
      >
        <div class="flex flex-col gap-4">
          <For each={groups()}>{(group) => <ProviderModelCard entry={group} />}</For>
        </div>
      </Show>
    </>
  )
}
