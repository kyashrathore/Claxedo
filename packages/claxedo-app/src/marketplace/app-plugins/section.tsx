import { For, Show, type JSX } from "solid-js"
import { useErrorCopy, useTranslator } from "@/i18n"
import { marketplaceDictionary } from "../i18n"
import { CatalogSkeleton, DIRECTORY_GRID, SectionHeading } from "../view/directory-sections"
import type { AppPluginActions } from "./actions"
import { AppPluginCard } from "./card"
import type { AppPluginDirectory } from "./directory"

function SectionNotes(props: { readonly directory: AppPluginDirectory }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const errorCopy = useErrorCopy("marketplace")
  const failure = () => props.directory.installed.error ?? props.directory.catalog.error
  const settled = () => props.directory.installed.isSuccess && props.directory.catalog.isSuccess
  return (
    <>
      <Show when={failure()}>
        {(error) => (
          <div role="alert" class="mb-2 rounded-lg border border-border-critical-base p-3 text-13-regular text-icon-critical-base">
            {t("marketplace.app.listFailed", { error: errorCopy(error()).message })}
          </div>
        )}
      </Show>
      <Show when={props.directory.catalog.data?.registry === "unavailable"}>
        <p role="status" class="mb-2 rounded-lg border border-border-weak-base p-3 text-12-regular text-text-weak">
          {t("marketplace.app.registryUnavailable")}
        </p>
      </Show>
      <Show when={settled() && props.directory.entries().length === 0 && props.directory.catalog.data?.registry === "listed"}>
        <p class="text-12-regular text-text-weak">{t("marketplace.app.empty")}</p>
      </Show>
    </>
  )
}

export function AppPluginsSection(props: {
  readonly directory: AppPluginDirectory
  readonly actions: AppPluginActions
  readonly selectedId: string | undefined
  readonly onOpen: (pluginId: string) => void
}): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  return (
    <section aria-label={t("marketplace.app.section")}>
      <SectionHeading title={t("marketplace.app.section")} count={props.directory.visible().length} note={t("marketplace.app.sectionNote")} />
      <SectionNotes directory={props.directory} />
      <Show when={props.directory.installed.isPending && !props.directory.installed.data}>
        <CatalogSkeleton />
      </Show>
      <Show when={props.directory.visible().length > 0}>
        <div class={DIRECTORY_GRID}>
          <For each={props.directory.visible()}>
            {(entry) => (
              <AppPluginCard
                entry={entry}
                selected={props.selectedId === entry.id}
                canManage={props.directory.canManage()}
                actions={props.actions}
                onOpen={() => props.onOpen(entry.id)}
              />
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}
