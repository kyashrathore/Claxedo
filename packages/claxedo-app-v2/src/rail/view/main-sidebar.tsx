import { A } from "@solidjs/router"
import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { settingsPath } from "@/shell"
import { Icon } from "@/ui"
import { dictionary } from "../i18n"
import "../rail.css"
import { GlobalNavigation } from "./global-navigation"
import { ProjectTree } from "./project-tree"

export function MainSidebar(): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <>
      <div
        class="flex-1 flex flex-col min-h-0 overflow-y-auto overflow-x-hidden rail-sidebar-scroll"
        style={{ "scrollbar-width": "thin", "scrollbar-color": "var(--scrollbar-thumb) transparent" }}
      >
        <GlobalNavigation />
        <ProjectTree />
      </div>
      <div class="rail-footer">
        <A href={settingsPath()} class="rail-item" data-testid="rail-settings">
          <Icon name="settings" />
          <span>{t("rail.settings")}</span>
        </A>
      </div>
    </>
  )
}
