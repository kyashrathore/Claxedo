import type { SettingsSectionId } from "./model"

export const SETTINGS_DEFAULT_SECTION: SettingsSectionId = "accounts"

export function settingsRoute(section: SettingsSectionId = SETTINGS_DEFAULT_SECTION): string {
  return `/settings/${section}`
}
