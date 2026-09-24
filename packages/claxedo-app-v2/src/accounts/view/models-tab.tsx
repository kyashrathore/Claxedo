import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useModelVisibility, type ModelRef } from "@/composer"
import { SettingsEmpty, SettingsList } from "@/settings"
import { Switch, Tag } from "@/ui"
import { catalogNeedsSearch, catalogProviders, MODELS_PREVIEW_COUNT, usesInlineSearch, visibleModels } from "../catalog-rules"
import { useAccountsText } from "../i18n"
import type { ModelItem, ModelSource, SourceGroup } from "../model-sources"
import { SearchField } from "./search-field"

export const modelKeyOf = (item: ModelItem): ModelRef => ({ providerId: item.provider.id, modelId: item.id })

export function groupContext(group: SourceGroup, item: ModelItem) {
  return { defaults: group.defaults, group: group.groupKey, ...(item.connected === undefined ? {} : { connected: item.connected }) }
}

export function enabledCount(source: ModelSource, visible: (item: ModelItem, group: SourceGroup) => boolean): number {
  return source.groups.reduce((total, group) => total + group.items.filter((item) => visible(item, group)).length, 0)
}

export function soleSelfGroup(source: ModelSource, harness: string): SourceGroup | undefined {
  const [group, ...rest] = source.groups
  return rest.length === 0 && group && group.groupKey === harness ? group : undefined
}

function ProviderModelList(props: { readonly entry: SourceGroup }) {
  const t = useAccountsText()
  const visibility = useModelVisibility()
  const [query, setQuery] = createSignal("")
  const items = createMemo(() => visibleModels(props.entry.items, query(), false))
  return (
    <div class="flex flex-col gap-2">
      <Show when={usesInlineSearch(props.entry.items.length, false)}>
        <SearchField value={query()} onChange={setQuery} placeholder={t("settings.models.providerSearch.placeholder", { provider: props.entry.providerName })} action="settings-models-model-search" />
        <Show when={!query().trim()}>
          <p class="text-12-regular text-text-weak px-0.5">{t("settings.models.providerSearch.hint", { shown: String(MODELS_PREVIEW_COUNT), total: String(props.entry.items.length) })}</p>
        </Show>
        <Show when={query().trim() && items().length === 0}>
          <p class="text-12-regular text-text-weak px-0.5">{t("settings.models.providerSearch.empty", { query: query().trim() })}</p>
        </Show>
      </Show>
      <SettingsList>
        <For each={items()}>
          {(item) => (
            <div class="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
              <span class="text-14-regular text-text-strong truncate">{item.name}</span>
              <Switch checked={visibility.visible(modelKeyOf(item), groupContext(props.entry, item))} onChange={(checked) => visibility.setVisibility(modelKeyOf(item), checked)} hideLabel>
                {item.name}
              </Switch>
            </div>
          )}
        </For>
      </SettingsList>
    </div>
  )
}

function GroupRow(props: { readonly entry: SourceGroup }) {
  const t = useAccountsText()
  const visibility = useModelVisibility()
  const [override, setOverride] = createSignal<boolean>()
  const enabled = createMemo(() => props.entry.items.filter((item) => visibility.visible(modelKeyOf(item), groupContext(props.entry, item))).length)
  const open = () => override() ?? enabled() > 0
  return (
    <div class="flex flex-col" data-provider={props.entry.providerId} data-group={props.entry.groupKey}>
      <div class="flex w-full items-center gap-2 rounded-md bg-surface-base px-2.5 py-1.5">
        <button type="button" class="flex min-w-0 flex-1 items-center gap-2 border-none bg-transparent text-left" data-action="settings-models-group-expand" aria-expanded={open()} onClick={() => setOverride(!open())}>
          <ProviderIcon id={props.entry.providerId} class="size-4 shrink-0 icon-strong-base" />
          <span class="min-w-0 flex-1 truncate text-compact text-text-base">{props.entry.providerName}</span>
        </button>
        <Show when={!props.entry.connected}>
          <Tag>{t("settings.providers.status.notConnected")}</Tag>
        </Show>
        <span class="shrink-0 text-12-regular tabular-nums text-text-weak">{t("settings.models.group.count", { enabled: String(enabled()), total: String(props.entry.items.length) })}</span>
        <button
          type="button"
          class="shrink-0 rounded-md border-none bg-transparent px-1 py-0.5 text-12-regular text-text-interactive-base"
          data-action="settings-models-group-toggle-all"
          onClick={() => visibility.setGroupVisibility(props.entry.groupKey, enabled() === 0, props.entry.items.map(modelKeyOf))}
        >
          {t(enabled() === 0 ? "settings.models.group.enableAll" : "settings.models.group.disableAll")}
        </button>
      </div>
      <Show when={open()}>
        <ProviderModelList entry={props.entry} />
      </Show>
    </div>
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
      <Show when={sole()}>{(group) => <ProviderModelList entry={group()} />}</Show>
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
        <div class="flex flex-col">
          <For each={groups()}>{(group) => <GroupRow entry={group} />}</For>
        </div>
      </Show>
    </>
  )
}
