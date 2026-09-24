import type { SettingsSection } from "@/shell"
import { useTranslator } from "@/i18n"
import { organizationSettingsSection } from "@/access"
import { usageSettingsSection } from "@/usage"
import { dictionary, type Keys } from "./i18n"
import { NotificationsSection, SoundsSection } from "./view/alerts"
import { AppearanceSection } from "./view/appearance"
import { ConnectionsSection } from "./view/connections"
import { LanguageSection } from "./view/language"
import { MachinesSection } from "./view/machines"
import { KeybindingsSection } from "./view/keybindings"

const title = (key: Keys) => () => useTranslator(dictionary)(key)

const section = (id: string, key: Keys, group: SettingsSection["group"], order: number, view: SettingsSection["view"]): SettingsSection => ({
  id,
  title: title(key),
  group,
  order,
  view,
})

export type { AppearancePreferences, ContrastLevels, ContrastScheme, NavigatorSide, Preferences, TranscriptPreferences } from "./preferences"
export { terminalFontFamily } from "./fonts"
export { CONTRAST_DEFAULTS, PreferencesProvider, TRANSCRIPT_DEFAULTS, usePreferences } from "./preferences"
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
