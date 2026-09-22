import { For, type Component } from "solid-js"
import { ClaxedoIcon as Icon, type ClaxedoIconName } from "@/ui/controls/claxedo-icon"
import { useLanguage } from "@/platform/i18n/provider"
import { useSettingsSectionRegistry } from "@/app/integrations/settings/settings-sections-registry"

/**
 * One row, drawn exactly as the rail's own navigation draws New Project,
 * Tasks and Marketplace.
 *
 * Duplicated rather than imported because `GlobalNavigation` owns that block's
 * composition — its rows, its border, its Documents gate — and none of that
 * belongs to settings. Only the row is shared, and the row is these classes.
 */
const NavRow: Component<{
  icon: ClaxedoIconName
  label: string
  active?: boolean
  onClick: () => void
  component?: string
  section?: string
  action?: string
}> = (props) => (
  <button
    type="button"
    data-component={props.component}
    data-section={props.section}
    data-action={props.action}
    aria-current={props.active ? "page" : undefined}
    class="w-full flex items-center gap-2 h-7 px-2.5 rounded-md text-compact leading-4 font-medium transition-[background-color,color] duration-100 active:scale-[0.98]"
    classList={{
      "bg-surface-base-hover text-text-strong": props.active,
      "text-text-base/80 hover:text-text-base hover:bg-surface-base-hover/35": !props.active,
    }}
    onClick={() => props.onClick()}
  >
    <span
      data-icon-interaction={props.active ? "persistent" : "passive"}
      class="flex size-4 shrink-0 items-center justify-center"
    >
      <Icon name={props.icon} size="small" class="transition-colors duration-100" />
    </span>
    <span class="min-w-0 truncate leading-4">{props.label}</span>
  </button>
)

/**
 * The settings sections, in the rail's own column.
 *
 * Drawn where the projects normally are, in the same block the rail's global
 * navigation uses, so the back row lands exactly where New Project was and the
 * sections read as the same kind of thing.
 *
 * One flat list. The sections were grouped by what they configure — the
 * desktop, the workspace, the account — which is a distinction the reader does
 * not make when looking for a setting, and "workspace" held one row.
 */
export const SettingsNav: Component<{
  section: string
  onSection: (section: string) => void
  onBack: () => void
}> = (props) => {
  const language = useLanguage()
  const sections = useSettingsSectionRegistry()

  return (
    <div class="flex flex-col gap-0.5 px-2.5 py-1.5" data-component="settings-nav">
      <NavRow
        icon="arrow-left"
        label={language.t("sidebar.settings")}
        action="settings-nav-back"
        onClick={() => props.onBack()}
      />
      <For each={sections()}>
        {(entry) => (
          <NavRow
            icon={entry.icon}
            label={entry.label}
            component="settings-nav-item"
            section={entry.id}
            active={props.section === entry.id}
            onClick={() => props.onSection(entry.id)}
          />
        )}
      </For>
    </div>
  )
}
