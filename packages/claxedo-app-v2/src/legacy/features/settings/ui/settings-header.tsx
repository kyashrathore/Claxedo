import { Show, type Component } from "solid-js"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { useLanguage } from "@/platform/i18n/provider"

/**
 * The bar above the settings column, matching the workbench's own.
 *
 * One tab and the sidebar control, and nothing on the right: the actions the
 * workbench header carries — new session, new terminal, the workspace panel —
 * all act on a workspace, and settings is not one.
 */
export const SettingsHeader: Component<{
  sidebarPinned: () => boolean
  onShowSidebar: () => void
  trafficLightPad: () => boolean
}> = (props) => {
  const language = useLanguage()
  return (
    <div
      class="flex h-9 shrink-0 items-center gap-1 border-b border-border-weaker-base pr-1"
      data-component="settings-header"
      style={{ "padding-left": props.trafficLightPad() && !props.sidebarPinned() ? "78px" : undefined }}
    >
      <div class="flex min-w-0 flex-1 items-center gap-1 px-1">
        <Show when={!props.sidebarPinned()}>
          <Tooltip value="Show Sidebar">
            <button
              type="button"
              aria-label="Show Sidebar"
              aria-pressed="false"
              data-icon-interaction="binary"
              data-action="settings-show-sidebar"
              class="relative z-[90] hidden size-6 shrink-0 items-center justify-center rounded-sm border-none bg-transparent p-0 text-icon-weak-base transition-colors hover:bg-surface-base-hover hover:text-icon-base md:flex"
              onClick={props.onShowSidebar}
            >
              <Icon name="layout-left-partial" size="small" />
            </button>
          </Tooltip>
        </Show>
        {/* Only while the rail is away. Pinned, the rail's own header already
            says Settings, and two of them is one too many. */}
        <Show when={!props.sidebarPinned()}>
          <span
            class="flex min-w-0 items-center gap-1.5 rounded-md bg-surface-base px-2.5 py-1 text-compact text-text-strong"
            data-component="settings-header-tab"
          >
            <Icon name="sliders" size="small" />
            <span class="truncate">{language.t("sidebar.settings")}</span>
          </span>
        </Show>
      </div>
    </div>
  )
}
