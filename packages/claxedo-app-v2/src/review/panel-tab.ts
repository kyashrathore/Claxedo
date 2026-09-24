import type { PanelTab } from "@/shell/types"
import { t } from "./i18n"
import { ChangesTab } from "./view/changes-tab"

export const changesPanelTab: PanelTab = {
  id: "changes",
  title: () => t("review.tab"),
  icon: "git-branch",
  order: 20,
  view: ChangesTab,
}
