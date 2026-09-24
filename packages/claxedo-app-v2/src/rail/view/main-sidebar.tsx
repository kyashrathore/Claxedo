import { A } from "@solidjs/router"
import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { settingsPath } from "@/shell"
import { Icon } from "@/ui"
import { dictionary } from "../i18n"
import "../rail.css"
import { SessionList } from "./session-list"
import { SidebarItems } from "./sidebar-items"

export function MainSidebar(): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <div class="rail" data-testid="main-sidebar">
      <SidebarItems />
      <SessionList />
      <div class="rail-footer">
        <A href={settingsPath()} class="rail-item" data-testid="rail-settings">
          <Icon name="settings" />
          <span>{t("rail.settings")}</span>
        </A>
      </div>
    </div>
  )
}
