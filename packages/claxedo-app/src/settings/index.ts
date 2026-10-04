import type { SettingsSection } from "@/shell"
import { useTranslator } from "@/i18n"
import { organizationSettingsSection } from "@/access"
import { usageSettingsSection } from "@/usage"
import { settingsDictionary, type SettingsKey } from "./i18n"
import { lazyView } from "@/lib/lazy-view"

const title = (key: SettingsKey) => () => useTranslator(settingsDictionary)(key)

const section = (id: string, key: SettingsKey, group: SettingsSection["group"], order: number, view: SettingsSection["view"]): SettingsSection => ({
  id,
  title: title(key),
  group,
  order,
  view,
})

export type { Preferences } from "./preferences"
export { terminalFontFamily } from "./fonts"
export { PreferencesProvider, usePreferences } from "./preferences"
export { MachineConnectSteps, useConnectMachine } from "./view/machines"
export { SettingsEmpty, SettingsGroup, SettingsIntro, SettingsList, SettingsNote, SettingsRow } from "./view/section"

export const settingsSections: readonly SettingsSection[] = [
  usageSettingsSection,
  organizationSettingsSection,
  section("connections", "settings.section.connections", "account", 40, lazyView(() => import("./view/connections").then((module) => module.ConnectionsSection))),
  section("machines", "settings.section.machines", "account", 45, lazyView(() => import("./view/machines").then((module) => module.MachinesSection))),
  section("language", "settings.section.language", "app", 50, lazyView(() => import("./view/language").then((module) => module.LanguageSection))),
  section("appearance", "settings.section.appearance", "app", 60, lazyView(() => import("./view/appearance").then((module) => module.AppearanceSection))),
  section("notifications", "settings.section.notifications", "app", 62, lazyView(() => import("./view/alerts").then((module) => module.NotificationsSection))),
  section("sounds", "settings.section.sounds", "app", 64, lazyView(() => import("./view/alerts").then((module) => module.SoundsSection))),
  section("keybindings", "settings.section.keybindings", "app", 70, lazyView(() => import("./view/keybindings").then((module) => module.KeybindingsSection))),
]
