import { createSignal, Show, type JSX } from "solid-js"
import { useServer, type PluginCandidate } from "@/server"
import { createPluginActions } from "../actions"
import { createDirectory, createSelection } from "../directory-state"
import { isBuiltIn, isInstalled } from "../model"
import { ALL, personalEntryKey } from "../sections"
import { createSourceActions } from "../source-actions"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import { AddSourceForm } from "./add-source"
import type { CardAction } from "./card"
import { PluginDetailPane } from "./detail-pane"
import { CategoryChips, SourceChips } from "./directory-chips"
import { DirectoryHeader } from "./directory-header"
import { CatalogSkeleton, DirectoryAlerts, PersonalSection, PluginSectionList } from "./directory-sections"
import { useInstallSheet } from "./install-sheet"
import { PersonalPane } from "./personal-pane"

function moveCardFocus(grid: HTMLElement | undefined, step: number) {
  if (!grid) return
  const cards = [...grid.querySelectorAll<HTMLButtonElement>("[data-directory-card-open]")]
  if (cards.length === 0) return
  const index = cards.findIndex((card) => card === document.activeElement)
  cards[index === -1 ? 0 : Math.min(cards.length - 1, Math.max(0, index + step))]?.focus()
}

function createCatalogControls(directory: ReturnType<typeof createDirectory>) {
  const server = useServer()
  const [refreshing, setRefreshing] = createSignal(false)
  const reread = async () => void (await directory.catalog.refetch())
  const refresh = async () => {
    setRefreshing(true)
    try {
      await server.marketplace.refresh()
    } finally {
      setRefreshing(false)
    }
  }
  return { reread, refresh, refreshing: () => refreshing() || directory.catalog.isFetching }
}

function createCardAction(
  actions: ReturnType<typeof createPluginActions>,
  add: (plugin: PluginCandidate) => Promise<void>,
) {
  const t = useTranslator(dictionary)
  return (plugin: PluginCandidate): CardAction | undefined => {
    if (isBuiltIn(plugin) || isInstalled(plugin)) return undefined
    const disabled =
      actions.pending() === plugin.pluginInstanceId || (!plugin.sourceAvailable && !plugin.retainedDigest)
    return plugin.retainedDigest
      ? { label: t("marketplace.action.enable"), disabled, run: () => void actions.activate(plugin, true) }
      : { label: t("marketplace.action.add"), disabled, run: () => void add(plugin) }
  }
}

function directoryKeys(selection: ReturnType<typeof createSelection>, grid: () => HTMLElement | undefined) {
  return (event: KeyboardEvent) => {
    if (event.key === "Escape" && selection.selectedId()) {
      event.preventDefault()
      return selection.closePlugin()
    }
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight"
    const back = event.key === "ArrowUp" || event.key === "ArrowLeft"
    if (!forward && !back) return
    event.preventDefault()
    moveCardFocus(grid(), forward ? 1 : -1)
  }
}

export function MarketplacePage(): JSX.Element {
  const t = useTranslator(dictionary)
  const directory = createDirectory()
  const selection = createSelection({ candidates: directory.candidates, personal: directory.personal })
  const controls = createCatalogControls(directory)
  const actions = createPluginActions({ catalog: () => directory.catalog.data, reread: controls.reread })
  const [adding, setAdding] = createSignal(false)
  const sources = createSourceActions({
    refresh: controls.refresh,
    onRemoved: () => directory.setFilter(ALL),
    onAdded: () => setAdding(false),
  })
  const openInstall = useInstallSheet()
  const add = async (plugin: PluginCandidate) => {
    const catalog = directory.catalog.data
    if (catalog) await openInstall(plugin, catalog.revision, catalog.supportedHarnesses)
  }
  const cardAction = createCardAction(actions, add)
  let grid: HTMLDivElement | undefined
  const onKeyDown = directoryKeys(selection, () => grid)
  return (
    <main
      data-agent-plugins-directory
      class="grid h-full min-h-0 grid-cols-[1fr_auto] bg-background-base"
      onKeyDown={onKeyDown}
    >
      <div class="min-w-0 overflow-y-auto px-6 py-5">
        <div class="mx-auto flex max-w-5xl flex-col gap-4">
          <DirectoryHeader
            query={directory.query()}
            onQuery={directory.setQuery}
            refreshing={controls.refreshing()}
            onRefresh={() => void controls.refresh()}
          />
          <SourceChips
            sources={directory.sourceViews()}
            count={directory.sourceCount}
            personalCount={directory.personalCount()}
            filter={directory.filter()}
            onFilter={directory.setFilter}
            removable={directory.removable()}
            onToggleAdd={() => setAdding((value) => !value)}
            onRemove={(source) => void sources.remove(source)}
          />
          <CategoryChips
            categories={directory.categories()}
            category={directory.category()}
            onCategory={directory.setCategory}
          />
          <Show when={adding()}>
            <AddSourceForm onAdd={sources.add} onCancel={() => setAdding(false)} />
          </Show>
          <DirectoryAlerts
            catalogError={directory.catalog.error?.message}
            sourcesError={directory.sources.error?.message}
            errors={directory.catalog.data?.errors ?? []}
          />
          <Show when={directory.catalog.isPending && !directory.catalog.data}>
            <CatalogSkeleton />
          </Show>
          <div ref={grid} class="flex flex-col gap-6">
            <PluginSectionList
              sections={directory.sections()}
              selectedId={selection.selectedId()}
              action={cardAction}
              onOpen={(plugin) => selection.openPlugin(plugin.pluginInstanceId)}
            />
            <PersonalSection
              entries={directory.personal()}
              error={directory.machine.error?.message}
              selectedKey={selection.personalKey()}
              onOpen={(entry) => selection.openPersonal(personalEntryKey(entry))}
            />
            <Show
              when={
                directory.sections().length === 0 && directory.personal().length === 0 && !directory.catalog.isPending
              }
            >
              <p class="text-13-regular text-text-weak">{t("marketplace.noMatches")}</p>
            </Show>
          </div>
        </div>
      </div>
      <Show when={selection.selectedPersonal()}>
        {(entry) => <PersonalPane entry={entry()} onClose={selection.closePersonal} />}
      </Show>
      <Show when={selection.selected()}>
        {(plugin) => (
          <PluginDetailPane
            plugin={plugin()}
            harnesses={directory.catalog.data?.supportedHarnesses ?? []}
            pending={actions.pending() === plugin().pluginInstanceId}
            onAdd={() => void add(plugin())}
            onActivate={(choice) => void actions.activate(plugin(), choice)}
            onUpdate={() => void actions.update(plugin())}
            onToolGroup={(group, enabled) => void actions.setToolGroup(plugin(), group, enabled)}
            onClose={selection.closePlugin}
          />
        )}
      </Show>
    </main>
  )
}
