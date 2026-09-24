import type { PanelTab } from "@/shell/types"
import { t } from "./i18n"
import { FilesTab } from "./view/files-tab"

export const filesPanelTab: PanelTab = {
  id: "files",
  title: () => t("files.tab"),
  icon: "folder",
  order: 10,
  view: FilesTab,
}
