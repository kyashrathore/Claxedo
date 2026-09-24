import { useTranslator } from "@/i18n"
import type { PanelTab } from "@/shell"
import { dictionary } from "./i18n"
import { ChangesTab } from "./view/changes-tab"

export const changesPanelTab: PanelTab = {
  id: "changes",
  title: () => useTranslator(dictionary)("review.tab"),
  icon: "changes",
  order: 20,
  view: ChangesTab,
}
