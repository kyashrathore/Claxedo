import { For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { MarketplaceCatalogError, PluginCandidate } from "@/server"
import { marketplaceDictionary } from "../i18n"
import { pluginStatus } from "../model"
import type { DirectorySection } from "../sections"
import { DirectoryCard, type CardAction } from "./card"

const GRID = "grid gap-2 grid-cols-[repeat(auto-fill,minmax(19rem,1fr))]"

function SectionHeading(props: {
  readonly title: string
  readonly count: number
  readonly note?: string
}): JSX.Element {
  return (
    <h2 class="mb-2 flex items-baseline gap-2 text-13-medium text-text-strong">
      {props.title}
      <span class="text-12-regular text-text-weaker">{props.count}</span>
      <Show when={props.note}>{(note) => <span class="text-12-regular text-text-weaker">{note()}</span>}</Show>
    </h2>
  )
}

export function CatalogSkeleton(): JSX.Element {
  return (
    <div aria-hidden="true" class={GRID}>
      <For each={[0, 1, 2]}>
        {() => (
          <div class="flex h-16 items-start gap-3 rounded-lg border border-border-weak-base bg-surface-base p-3">
            <div class="size-10 shrink-0 rounded-lg bg-surface-raised-stronger" />
            <div class="flex min-w-0 flex-1 flex-col gap-2 pt-1">
              <div class="h-3 w-1/3 rounded-sm bg-surface-raised-stronger" />
              <div class="h-2.5 w-4/5 rounded-sm bg-surface-raised-base" />
            </div>
          </div>
        )}
      </For>
    </div>
  )
}

export function PluginSectionList(props: {
  readonly sections: readonly DirectorySection[]
  readonly selectedId?: string
  readonly action: (plugin: PluginCandidate) => CardAction | undefined
  readonly onOpen: (plugin: PluginCandidate) => void
}): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const title = (section: DirectorySection) => ("key" in section.title ? t(section.title.key) : section.title.text)
  return (
    <For each={props.sections}>
      {(section) => (
        <section aria-label={title(section)}>
          <SectionHeading
            title={title(section)}
            count={section.plugins.length}
            note={section.note ? t(section.note) : undefined}
          />
          <div class={GRID}>
            <For each={section.plugins}>
              {(plugin) => (
                <DirectoryCard
                  plugin={plugin}
                  status={pluginStatus(plugin)}
                  selected={props.selectedId === plugin.pluginInstanceId}
                  action={props.action(plugin)}
                  onOpen={() => props.onOpen(plugin)}
                />
              )}
            </For>
          </div>
        </section>
      )}
    </For>
  )
}

export function DirectoryAlerts(props: {
  readonly catalogError?: string
  readonly sourcesError?: string
  readonly errors: readonly MarketplaceCatalogError[]
}): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  return (
    <>
      <Show when={props.catalogError}>
        {(error) => (
          <div
            role="alert"
            class="rounded-lg border border-border-critical-base p-3 text-13-regular text-icon-critical-base"
          >
            {error()}
          </div>
        )}
      </Show>
      <Show when={props.sourcesError}>
        {(error) => (
          <div role="alert" class="rounded-lg border border-border-weak-base p-3 text-12-regular text-text-weak">
            {t("marketplace.sourcesUnavailable", { error: error() })}
          </div>
        )}
      </Show>
      <Show when={props.errors.length}>
        <section class="rounded-lg border border-border-weak-base p-3">
          <h2 class="text-13-medium text-text-strong">{t("marketplace.invalidEntries")}</h2>
          <For each={props.errors}>
            {(error) => (
              <p class="mt-1 text-12-regular text-text-weak">
                {error.sourceId}/{error.relativePath}: {error.message}
              </p>
            )}
          </For>
        </section>
      </Show>
    </>
  )
}
