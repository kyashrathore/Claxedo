export { TASKS_PAGE_PATH } from "./links"
import { useTranslator } from "@/i18n"
import { lazyView } from "@/lib/lazy-view"
import type { SettingsSection } from "@/shell"
import { tasksDictionary } from "./i18n"
import { PRESETS_SECTION_ID } from "./links"

export const TasksPage = lazyView(() => import("./view/tasks-page").then((module) => module.TasksPage))

export const presetsSettingsSection: SettingsSection = {
  id: PRESETS_SECTION_ID,
  title: () => useTranslator(tasksDictionary)("tasks.preset.title"),
  group: "workspace",
  order: 30,
  view: lazyView(() => import("./presets/presets-section").then((module) => module.PresetsSection)),
}
