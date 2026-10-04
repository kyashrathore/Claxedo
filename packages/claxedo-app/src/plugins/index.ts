import { useI18n } from "@/i18n"
import { lazyView } from "@/lib/lazy-view"
import type { SettingsSection } from "@/shell"

export { PluginHostProvider } from "./provider"

export const pluginsSettingsSection: SettingsSection = {
  id: "app-plugins",
  title: () => useI18n().t("plugins.settings.title"),
  group: "app",
  order: 90,
  view: lazyView(() => import("./view/settings-section").then((module) => module.PluginsSettings)),
}
