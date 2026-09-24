import type { PanelTab } from "@/shell/types"
import { t } from "./i18n"
import { BrowserTabView } from "./view/browser-tab"

export const browserPanelTab: PanelTab = {
  id: "browser",
  title: () => t("browser.tab"),
  icon: "globe",
  order: 30,
  view: BrowserTabView,
}
