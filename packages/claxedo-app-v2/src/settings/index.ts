import type { PageEntry, SettingsSection } from "@/shell/types"
import { useTranslator } from "@/i18n"
import { organizationSettingsSection } from "@/access"
import { dictionary, type Keys } from "./i18n"
import { AccountsSection } from "./view/accounts"
import { AppearanceSection } from "./view/appearance"
import { ConnectionsSection } from "./view/connections"
import { KeybindingsSection } from "./view/keybindings"
import { createSettingsPage } from "./view/page"
import { SandboxSection } from "./view/sandbox"
import { TerminalsSection } from "./view/terminals"

export type { SettingsSectionId, AppearancePreferences, ColorScheme } from "./model"
export type { Settings } from "./provider"
export type { Appearance } from "./preferences"
export type { Accounts } from "./store"
export { SettingsProvider, useSettings } from "./provider"
export { settingsRoute } from "./route"

const title = (key: Keys) => () => useTranslator(dictionary)(key)

const section = (id: string, key: Keys, group: SettingsSection["group"], order: number, view: SettingsSection["view"]): SettingsSection => ({
  id,
  title: title(key),
  group,
  order,
  view,
})

export const settingsSections: readonly SettingsSection[] = [
  section("accounts", "settings.section.accounts", "account", 10, AccountsSection),
  organizationSettingsSection,
  section("connections", "settings.section.connections", "account", 40, ConnectionsSection),
  section("sandbox", "settings.section.sandbox", "workspace", 50, SandboxSection),
  section("appearance", "settings.section.appearance", "app", 60, AppearanceSection),
  section("keybindings", "settings.section.keybindings", "app", 70, KeybindingsSection),
  section("terminals", "settings.section.terminals", "app", 80, TerminalsSection),
]

export const settingsPage: PageEntry = {
  id: "settings",
  path: "/settings/:section",
  title: title("settings.title"),
  icon: "settings",
  sidebar: "settings",
  view: createSettingsPage(() => settingsSections),
}
