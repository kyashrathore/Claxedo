import { createMemo, For, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { byOrder, fillPattern, RegistryIcon, useShellRegistries, useShellRoute, type PageEntry, type SidebarItem } from "@/shell"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { dictionary } from "../i18n"

export const TASKS_PATH = "/tasks"
export const MARKETPLACE_PATH = "/marketplace"

const ROW_CLASS =
  "w-full flex items-center gap-2 h-7 px-2.5 rounded-md text-compact leading-4 font-medium transition-[background-color,color] duration-100 active:scale-[0.98]"

function rowState(active: boolean) {
  return {
    "bg-surface-base-hover text-text-strong": active,
    "text-text-base/80 hover:text-text-base hover:bg-surface-base-hover/35": !active,
  }
}

function NavigationRow(props: {
  readonly icon: "marketplace" | "checklist"
  readonly label: string
  readonly ariaLabel: string
  readonly testId: string
  readonly active: boolean
  readonly onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-current={props.active ? "page" : undefined}
      class={ROW_CLASS}
      classList={rowState(props.active)}
      onClick={() => props.onClick()}
      aria-label={props.ariaLabel}
    >
      <span data-icon-interaction={props.active ? "persistent" : "passive"} class="flex size-4 shrink-0 items-center justify-center">
        <Icon name={props.icon} size="small" class="transition-colors duration-100" />
      </span>
      <span class="min-w-0 truncate leading-4">{props.label}</span>
    </button>
  )
}

function PluginRows(): JSX.Element {
  const registries = useShellRegistries()
  const routing = useShellRoute()
  const links = createMemo<readonly { readonly item: SidebarItem; readonly page: PageEntry }[]>(() =>
    byOrder(registries.sidebarItems.list()).flatMap((item) => {
      const page = registries.pages.list().find((candidate) => candidate.id === item.pageId)
      return page ? [{ item, page }] : []
    }),
  )
  const activePageId = () => {
    const route = routing.route()
    return route.kind === "page" ? route.page.id : undefined
  }
  return (
    <For each={links()}>
      {(link) => (
        <button
          type="button"
          aria-current={activePageId() === link.page.id ? "page" : undefined}
          class={ROW_CLASS}
          classList={rowState(activePageId() === link.page.id)}
          onClick={() => routing.navigate(fillPattern(link.page.path))}
        >
          <span class="flex size-4 shrink-0 items-center justify-center">
            <RegistryIcon name={link.item.icon} size="small" />
          </span>
          <span class="min-w-0 truncate leading-4">{link.item.title()}</span>
        </button>
      )}
    </For>
  )
}

export function GlobalNavigation(): JSX.Element {
  const t = useTranslator(dictionary)
  const routing = useShellRoute()
  const at = (path: string) => routing.pathname().startsWith(path)
  return (
    <div data-testid="global-navigation" data-slot="global-navigation" class="flex flex-col gap-0.5 px-2.5 py-1.5 border-b border-border-weak-base/15">
      <NavigationRow
        icon="checklist"
        label={t("rail.tasks")}
        ariaLabel={t("rail.openTasks")}
        testId="sidebar-tasks-entry"
        active={at(TASKS_PATH)}
        onClick={() => routing.navigate(TASKS_PATH)}
      />
      <NavigationRow
        icon="marketplace"
        label={t("rail.marketplace")}
        ariaLabel={t("rail.openMarketplace")}
        testId="sidebar-marketplace-entry"
        active={at(MARKETPLACE_PATH)}
        onClick={() => routing.navigate(MARKETPLACE_PATH)}
      />
      <PluginRows />
    </div>
  )
}
