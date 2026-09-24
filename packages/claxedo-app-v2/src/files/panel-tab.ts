import { useTranslator } from "@/i18n"
import type { PanelTab } from "@/shell"
import { dictionary } from "./i18n"
import { FilesTab } from "./view/files-tab"

export const filesPanelTab: PanelTab = {
  id: "files",
  title: () => useTranslator(dictionary)("files.tab"),
  icon: "folder",
  order: 10,
  view: FilesTab,
}
