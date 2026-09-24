import { useTranslator } from "@/i18n"
import type { PanelTab } from "@/shell"
import { dictionary } from "./i18n"
import { BrowserTabView } from "./view/browser-tab"

export const browserPanelTab: PanelTab = {
  id: "browser",
  title: () => useTranslator(dictionary)("browser.tab"),
  icon: "globe",
  order: 30,
  view: BrowserTabView,
}
