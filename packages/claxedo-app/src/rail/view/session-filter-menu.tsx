import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { useShellLayout } from "@/shell"
import { ClaxedoIcon, DropdownMenu, Tooltip } from "@/ui"
import { railDictionary } from "../i18n"

export function SessionFilterMenu(): JSX.Element {
  const t = useTranslator(railDictionary)
  const layout = useShellLayout()
  return (
    <DropdownMenu placement="bottom-end" gutter={4} fitViewport>
      <Tooltip value={t("rail.activity.filter")} class="ui-session-options-anchor">
        <DropdownMenu.Trigger aria-label={t("rail.activity.filter")} data-icon-interaction="binary" class="ui-session-options-trigger flex shrink-0 items-center justify-center rounded-md text-icon-weak-base hover:text-icon-base hover:bg-surface-base-hover/35 focus-visible:ring-2 focus-visible:ring-border-interactive-base">
          <ClaxedoIcon name="sliders" size="small" />
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content aria-label={t("rail.activity.filter")} class="z-[120] min-w-48 max-w-[calc(100vw-24px)]">
          <DropdownMenu.RadioGroup value={layout.sidebarView()} onChange={(value) => (value === "projects" || value === "activity") && layout.setSidebarView(value)}>
            <DropdownMenu.GroupLabel>{t("rail.activity.view")}</DropdownMenu.GroupLabel>
            <DropdownMenu.RadioItem value="projects" closeOnSelect class="ui-session-options-choice">{t("rail.projects")}</DropdownMenu.RadioItem>
            <DropdownMenu.RadioItem value="activity" closeOnSelect class="ui-session-options-choice">{t("rail.activity")}</DropdownMenu.RadioItem>
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator />
          <DropdownMenu.CheckboxItem checked={layout.hideWorkingStatus()} onChange={(hide) => layout.setHideWorkingStatus(hide)} closeOnSelect={false} class="ui-session-options-choice">
            <ClaxedoIcon name="eye" size="small" />
            <span>{t("rail.hideWorkingStatus")}</span>
          </DropdownMenu.CheckboxItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )
}
