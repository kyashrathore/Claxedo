import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { usePreferences } from "@/settings"
import { settingsPath, useShellRoute } from "@/shell"
import { railDictionary } from "../i18n"
import { AccountCard } from "./account-card"
import { ActivityView } from "./activity-view"
import { GlobalNavigation } from "./global-navigation"
import { ProjectTree } from "./project-tree"
import { moveRowFocus } from "./row-navigation"
import { createActivityFilter, SessionsHeading } from "./sessions-heading"
import { SharedSessionsSection } from "./shared-sessions"
import { ClaxedoIcon as Icon } from "@/ui"

function SettingsEntry(): JSX.Element {
  const t = useTranslator(railDictionary)
  const routing = useShellRoute()
  const active = () => routing.pathname().startsWith(settingsPath())
  return (
    <button
      type="button"
      aria-current={active() ? "page" : undefined}
      class="sidebar-row w-full flex items-center gap-2 leading-4 font-medium transition-[background-color,color] duration-100"
      classList={{ "bg-surface-base-hover text-text-strong": active(), "text-text-base/80 hover:text-text-base hover:bg-surface-base-hover/35": !active() }}
      onClick={() => routing.navigate(settingsPath())}
    >
      <span class="flex size-4 shrink-0 items-center justify-center">
        <Icon name="settings-gear" size="small" />
      </span>
      <span class="min-w-0 truncate leading-4">{t("rail.settings")}</span>
    </button>
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
        <SessionsHeading filter={shownFilter()} onCycle={() => filter.send({ type: "cycled" })} onShowWorking={() => filter.send({ type: "reset" })} />
        <div class="flex-1 flex flex-col" onKeyDown={moveRowFocus}>
          <Show when={preferences.sidebar.view === "activity"} fallback={<><ProjectTree /><SharedSessionsSection /></>}>
            <ActivityView filter={shownFilter()} />
          </Show>
        </div>
      </div>
      <div class="px-2.5 py-2">
        <SettingsEntry />
        <div ref={foot} class="flex items-center gap-1 border-t border-border-weak-base/15 pt-2 mt-1">
          <div class="min-w-0 flex-1">
            <AccountCard anchor={() => foot} />
          </div>
        </div>
      </div>
    </>
  )
}
