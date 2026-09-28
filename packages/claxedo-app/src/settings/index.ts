import type { SettingsSection } from "@/shell"
import { useTranslator } from "@/i18n"
import { organizationSettingsSection } from "@/access"
import { usageSettingsSection } from "@/usage"
import { settingsDictionary, type SettingsKey } from "./i18n"
import { NotificationsSection, SoundsSection } from "./view/alerts"
import { AppearanceSection } from "./view/appearance"
import { ConnectionsSection } from "./view/connections"
import { LanguageSection } from "./view/language"
import { MachinesSection } from "./view/machines"
import { KeybindingsSection } from "./view/keybindings"

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
export { SettingsEmpty, SettingsGroup, SettingsIntro, SettingsList, SettingsNote, SettingsRow } from "./view/section"

export const settingsSections: readonly SettingsSection[] = [
  usageSettingsSection,
  organizationSettingsSection,
  section("connections", "settings.section.connections", "account", 40, ConnectionsSection),
  section("machines", "settings.section.machines", "account", 45, MachinesSection),
  section("language", "settings.section.language", "app", 50, LanguageSection),
  section("appearance", "settings.section.appearance", "app", 60, AppearanceSection),
  section("notifications", "settings.section.notifications", "app", 62, NotificationsSection),
  section("sounds", "settings.section.sounds", "app", 64, SoundsSection),
  section("keybindings", "settings.section.keybindings", "app", 70, KeybindingsSection),
]
