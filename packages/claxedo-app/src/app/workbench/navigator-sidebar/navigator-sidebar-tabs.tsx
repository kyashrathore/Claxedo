import { For } from "solid-js"
import { SemanticIcon } from "@/ui/semantic-icon"
import { useLanguage } from "@/platform/i18n/provider"
import type { WorkspacePanelNavigator } from "../../../features/workspaces/ui/panel/workspace-panel-state"

export const NAVIGATOR_SIDEBAR_TABS = ["files", "changes", "processes"] as const satisfies readonly WorkspacePanelNavigator[]

export function NavigatorSidebarTabs(props: {
  active: WorkspacePanelNavigator
  onSelect: (tab: WorkspacePanelNavigator) => void
}) {
  const language = useLanguage()
  return (
    <div role="tablist" class="claxedo-navigator-sidebar-tabs flex h-9 shrink-0 items-stretch border-b border-border-weak-base">
      <For each={NAVIGATOR_SIDEBAR_TABS}>
        {(tab) => (
          <button
            type="button"
            role="tab"
            data-tab={tab}
            data-testid={`navigator-sidebar-tab-${tab}`}
            aria-selected={props.active === tab ? "true" : "false"}
            tabIndex={props.active === tab ? 0 : -1}
            class="claxedo-navigator-sidebar-tab flex min-w-0 flex-1 items-center justify-center gap-1.5 px-2 text-13-regular text-text-weak transition-colors hover:text-text-base [&_[data-slot=icon-svg]]:!size-3.5"
            onClick={() => props.onSelect(tab)}
          >
            <SemanticIcon concept={tab} size="small" />
            <span class="truncate">{language.t(`navigator.sidebar.tab.${tab}`)}</span>
          </button>
        )}
      </For>
    </div>
  )
}
