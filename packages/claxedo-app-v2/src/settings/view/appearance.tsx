import { Select } from "@/ui"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme"
import { useI18n, useTranslator, type Locale } from "@/i18n"
import { dictionary } from "../i18n"
import { SettingsGroup, SettingsList, SettingsRow } from "./section"

const SCHEMES: readonly ColorScheme[] = ["system", "light", "dark"]

const SCHEME_KEY = {
  system: "settings.appearance.scheme.system",
  light: "settings.appearance.scheme.light",
  dark: "settings.appearance.scheme.dark",
} as const satisfies Record<ColorScheme, string>

export function AppearanceSection() {
  const t = useTranslator(dictionary)
  const i18n = useI18n()
  const theme = useTheme()
  const localeLabel = (code: Locale) => i18n.locales.find((entry) => entry.code === code)?.label ?? code

  return (
    <div class="settings-body" data-component="settings-appearance">
      <SettingsGroup>
        <SettingsList>
          <SettingsRow title={t("settings.appearance.language")} description={t("settings.appearance.language.description")}>
            <Select options={i18n.locales.map((entry) => entry.code)} current={i18n.locale()} value={(code) => code} label={localeLabel} onSelect={(code) => code && i18n.setLocale(code)} />
          </SettingsRow>
          <SettingsRow title={t("settings.appearance.colorScheme")} description={t("settings.appearance.colorScheme.description")}>
            <Select options={[...SCHEMES]} current={theme.colorScheme()} value={(scheme) => scheme} label={(scheme) => t(SCHEME_KEY[scheme])} onSelect={(scheme) => scheme && theme.setColorScheme(scheme)} />
          </SettingsRow>
          <SettingsRow title={t("settings.appearance.theme")} description={t("settings.appearance.theme.description")}>
            <Select options={theme.ids()} current={theme.themeId()} value={(id) => id} label={(id) => theme.name(id)} onSelect={(id) => id && theme.setTheme(id)} />
          </SettingsRow>
        </SettingsList>
      </SettingsGroup>
    </div>
  )
}
