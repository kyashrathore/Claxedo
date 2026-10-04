import { For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { PluginSourceRecord } from "@/server"
import { Button } from "@/ui"
import { marketplaceDictionary } from "../i18n"
import { ALL, PERSONAL, type DirectorySourceView, type PluginCategoryView } from "../sections"

function Chip(props: {
  readonly id: string
  readonly label: string
  readonly count?: number
  readonly active: boolean
  readonly onSelect: (id: string) => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.active}
      data-source-chip={props.id}
      class="rounded-full border px-3 py-1 text-12-regular"
      classList={{
        "border-border-strong-base bg-surface-raised-base text-text-strong": props.active,
        "border-border-weak-base text-text-weak": !props.active,
      }}
      onClick={() => props.onSelect(props.id)}
    >
      {props.label}
      <Show when={props.count !== undefined}>
        <span class="ml-1.5 text-text-weaker">{props.count}</span>
      </Show>
    </button>
  )
}

export function SourceChips(props: {
  readonly sources: readonly DirectorySourceView[]
  readonly count: (id: string) => number
  readonly personalCount: number
  readonly filter: string
  readonly onFilter: (id: string) => void
  readonly removable?: PluginSourceRecord
  readonly onToggleAdd: () => void
  readonly onRemove: (source: PluginSourceRecord) => void
}): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  return (
    <div role="tablist" aria-label={t("marketplace.sources")} class="flex flex-wrap items-center gap-2">
      <Chip id={ALL} label={t("marketplace.all")} active={props.filter === ALL} onSelect={props.onFilter} />
      <For each={props.sources}>
        {(source) => (
          <Chip
            id={source.id}
            label={source.label}
            count={props.count(source.id)}
            active={props.filter === source.id}
            onSelect={props.onFilter}
          />
        )}
      </For>
      <Chip
        id={PERSONAL}
        label={t("marketplace.personal")}
        count={props.personalCount}
        active={props.filter === PERSONAL}
        onSelect={props.onFilter}
      />
      <Button size="small" variant="ghost" onClick={() => props.onToggleAdd()}>
        {t("marketplace.source.addButton")}
      </Button>
      <Show when={props.removable}>
        {(source) => (
          <Button size="small" variant="ghost" onClick={() => props.onRemove(source())}>
            {t("marketplace.source.remove", { label: source().label })}
          </Button>
        )}
      </Show>
    </div>
  )
}

export function CategoryChips(props: {
  readonly categories: readonly PluginCategoryView[]
  readonly category: string
  readonly onCategory: (id: string) => void
}): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  return (
    <Show when={props.categories.length > 0}>
      <div role="tablist" aria-label={t("marketplace.categories")} class="flex flex-wrap items-center gap-2">
        <Chip
          id={ALL}
          label={t("marketplace.allCategories")}
          active={props.category === ALL}
          onSelect={props.onCategory}
        />
        <For each={props.categories}>
          {(entry) => (
            <Chip
              id={entry.id}
              label={t(entry.key)}
              count={entry.count}
              active={props.category === entry.id}
              onSelect={props.onCategory}
            />
          )}
        </For>
      </div>
    </Show>
  )
}
