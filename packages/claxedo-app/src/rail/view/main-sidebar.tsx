import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { usePreferences } from "@/settings"
import { settingsPath, useShellRoute } from "@/shell"
import { createActivityFilter } from "../activity-filter"
import { railDictionary } from "../i18n"
import { AccountCard, USAGE_SECTION } from "./account-card"
import { ActivityView } from "./activity-view"
import { GlobalNavigation } from "./global-navigation"
import { ProjectTree } from "./project-tree"
import { moveRowFocus } from "./row-navigation"
import { SessionsHeading } from "./sessions-heading"
import { SharedSessionsSection } from "./shared-sessions"
import { ClaxedoIcon as Icon, Tooltip } from "@/ui"

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
  const preferences = usePreferences()
  const filter = createActivityFilter()
  const shownFilter = () => (preferences.sidebar.hideWorkingStatus ? filter.state().kind : "all")
  let foot: HTMLDivElement | undefined
  return (
    <>
      <div
        class="flex-1 flex flex-col min-h-0 overflow-y-auto overflow-x-hidden rail-sidebar-scroll"
        data-hide-working-status={preferences.sidebar.hideWorkingStatus ? "true" : "false"}
        style={{ "scrollbar-width": "thin", "scrollbar-color": "var(--scrollbar-thumb) transparent" }}
      >
        <GlobalNavigation />
        <SessionsHeading filter={shownFilter()} onCycle={() => filter.send({ type: "cycled" })} />
        <div class="flex-1 flex flex-col" onKeyDown={moveRowFocus}>
          <Show when={preferences.sidebar.view === "activity"} fallback={<><ProjectTree /><SharedSessionsSection /></>}>
            <ActivityView filter={shownFilter()} />
          </Show>
        </div>
      </div>
      <div class="px-2.5 py-2">
        <div ref={foot} class="flex items-center gap-1 border-t border-border-weak-base/15 pt-2">
          <div class="min-w-0 flex-1">
            <AccountCard anchor={() => foot} />
          </div>
          <UsageButton />
        </div>
      </div>
    </>
  )
}
