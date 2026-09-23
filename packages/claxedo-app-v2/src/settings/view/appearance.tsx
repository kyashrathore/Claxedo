import { Select, Switch, TextInput, useTheme, type ColorScheme } from "@/ui"
import { useI18n, useTranslator, type Locale } from "@/i18n"
import { dictionary } from "../i18n"
import { useSettings } from "../provider"
import { SettingsGroup, SettingsHeading, SettingsList, SettingsRow } from "./section"

const SCHEMES: readonly ColorScheme[] = ["system", "light", "dark"]

const SCHEME_KEY = {
  system: "settings.appearance.scheme.system",
  light: "settings.appearance.scheme.light",
  dark: "settings.appearance.scheme.dark",
} as const

export function AppearanceSection() {
  const t = useTranslator(dictionary)
  const i18n = useI18n()
  const theme = useTheme()
  const { appearance } = useSettings()
  const locales = () => i18n.locales.map((entry) => entry.code)
  const localeLabel = (code: Locale) => i18n.locales.find((entry) => entry.code === code)?.label ?? code
  const themeName = (id: string) => theme.themes().find((entry) => entry.id === id)?.name ?? id

  return (
    <div class="settings-page" data-component="settings-appearance">
      <SettingsHeading title={t("settings.section.appearance")} />
      <SettingsGroup>
        <SettingsList>
          <SettingsRow title={t("settings.appearance.language")} description={t("settings.appearance.language.description")}>
            <Select options={locales()} current={i18n.locale()} value={(code) => code} label={localeLabel} onSelect={(code) => code && i18n.setLocale(code)} aria-label={t("settings.appearance.language")} />
          </SettingsRow>
          <SettingsRow title={t("settings.appearance.colorScheme")} description={t("settings.appearance.colorScheme.description")}>
            <Select options={[...SCHEMES]} current={theme.colorScheme()} value={(scheme) => scheme} label={(scheme) => t(SCHEME_KEY[scheme])} onSelect={(scheme) => scheme && theme.setColorScheme(scheme)} aria-label={t("settings.appearance.colorScheme")} />
          </SettingsRow>
          <SettingsRow title={t("settings.appearance.theme")} description={t("settings.appearance.theme.description")}>
            <Select options={theme.themes().map((entry) => entry.id)} current={theme.themeId()} value={(id) => id} label={themeName} onSelect={(id) => id && theme.setTheme(id)} aria-label={t("settings.appearance.theme")} />
          </SettingsRow>
        </SettingsList>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsList>
          <FontRow title={t("settings.appearance.uiFont")} description={t("settings.appearance.uiFont.description")} value={appearance.prefs.uiFont} onChange={(value) => appearance.set("uiFont", value)} />
          <FontRow title={t("settings.appearance.codeFont")} description={t("settings.appearance.codeFont.description")} value={appearance.prefs.codeFont} onChange={(value) => appearance.set("codeFont", value)} />
          <FontRow title={t("settings.appearance.terminalFont")} description={t("settings.appearance.terminalFont.description")} value={appearance.prefs.terminalFont} onChange={(value) => appearance.set("terminalFont", value)} />
        </SettingsList>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsList>
          <ToggleRow title={t("settings.appearance.screenReader")} description={t("settings.appearance.screenReader.description")} checked={appearance.prefs.terminalScreenReader} onChange={(checked) => appearance.set("terminalScreenReader", checked)} />
          <ToggleRow title={t("settings.appearance.reasoningSummaries")} description={t("settings.appearance.reasoningSummaries.description")} checked={appearance.prefs.reasoningSummaries} onChange={(checked) => appearance.set("reasoningSummaries", checked)} />
          <ToggleRow title={t("settings.appearance.shellToolParts")} description={t("settings.appearance.shellToolParts.description")} checked={appearance.prefs.shellToolPartsExpanded} onChange={(checked) => appearance.set("shellToolPartsExpanded", checked)} />
          <ToggleRow title={t("settings.appearance.editToolParts")} description={t("settings.appearance.editToolParts.description")} checked={appearance.prefs.editToolPartsExpanded} onChange={(checked) => appearance.set("editToolPartsExpanded", checked)} />
        </SettingsList>
      </SettingsGroup>
    </div>
  )
}

function FontRow(props: { readonly title: string; readonly description: string; readonly value: string; readonly onChange: (value: string) => void }) {
  return (
    <SettingsRow title={props.title} description={props.description}>
      <TextInput aria-label={props.title} value={props.value} spellcheck={false} autocomplete="off" onChange={(event) => props.onChange(event.currentTarget.value)} />
    </SettingsRow>
  )
}

function ToggleRow(props: { readonly title: string; readonly description: string; readonly checked: boolean; readonly onChange: (checked: boolean) => void }) {
  return (
    <SettingsRow title={props.title} description={props.description}>
      <Switch hideLabel checked={props.checked} onChange={(checked: boolean) => props.onChange(checked)}>
        {props.title}
      </Switch>
    </SettingsRow>
  )
}
