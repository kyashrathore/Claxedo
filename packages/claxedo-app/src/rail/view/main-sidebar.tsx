import { createEffect, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { settingsPath, useShellRoute, useShellLayout } from "@/shell"
import { railDictionary } from "../i18n"
import { AccountCard, USAGE_SECTION } from "./account-card"
import { GlobalNavigation } from "./global-navigation"
import { ProjectNavigation } from "./project-navigation"
import { ClaxedoIcon as Icon, Tooltip } from "@/ui"
import { ActivityView } from "./activity-view"
import { useSessionStores } from "@/session"
import { ActivityFilterToggle, activityHeading } from "./activity-filter-toggle"
import { SessionFilterMenu } from "./session-filter-menu"
import "../sidebar-navigation.css"

function UsageButton(): JSX.Element {
  const t = useTranslator(railDictionary)
  const routing = useShellRoute()
  return (
    <Tooltip value={t("rail.account.usage")}>
      <button
        type="button"
        aria-label={t("rail.account.usage")}
        data-testid="rail-usage"
        class="flex size-[var(--sidebar-row-height)] shrink-0 items-center justify-center rounded-[var(--sidebar-row-radius)] text-icon-weak-base transition-colors hover:bg-[var(--row-surface-hover)] hover:text-icon-base"
        onClick={() => routing.navigate(settingsPath(USAGE_SECTION))}
      >
        <Icon name="gauge" size="small" />
      </button>
    </Tooltip>
  )
}

export function MainSidebar(): JSX.Element {
  const t = useTranslator(railDictionary)
  const layout = useShellLayout()
  const inventory = useSessionStores().list.inventory
  createEffect(() => { if (!layout.hideWorkingStatus()) void inventory.resetFilter() })
  let foot: HTMLDivElement | undefined
  return (
    <>
      <div
        class="flex-1 flex flex-col min-h-0 overflow-hidden"
        data-hide-working-status={layout.hideWorkingStatus()}
        style={{ "scrollbar-width": "thin", "scrollbar-color": "var(--scrollbar-thumb) transparent" }}
      >
        <div class="ui-main-sidebar-navigation flex shrink-0 flex-col">
          <GlobalNavigation />
          <div data-slot="session-sidebar-heading" class="ui-session-sidebar-heading flex shrink-0 items-center justify-between px-4 text-[12px] font-normal text-text-weaker">
            <h2 class="ui-session-sidebar-title">{t(layout.sidebarView() === "activity" ? activityHeading(inventory.filter()) : "rail.projects")}</h2>
            <div class="ui-session-options flex items-center"><Show when={layout.hideWorkingStatus() && layout.sidebarView() === "activity"}><ActivityFilterToggle /></Show><SessionFilterMenu /></div>
          </div>
        </div>
        <Show when={layout.sidebarView() === "activity"} fallback={<ProjectNavigation />}>
          <ActivityView />
        </Show>
      </div>
      <div class="ui-main-sidebar-footer px-2.5 py-2">
        <div ref={foot} class="ui-main-sidebar-account flex items-center gap-1 border-t border-border-weak-base/15 pt-2">
          <div class="min-w-0 flex-1">
            <AccountCard anchor={() => foot} />
          </div>
          <UsageButton />
        </div>
      </div>
    </>
  )
}
