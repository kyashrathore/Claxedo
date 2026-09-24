import { Select } from "@opencode-ai/ui/select"
import { useI18n, useTranslator, type Locale } from "@/i18n"
import { dictionary } from "../i18n"
import { SettingsGroup, SettingsList, SettingsRow } from "./section"

export function LanguageSection() {
  const t = useTranslator(dictionary)
  const i18n = useI18n()
  const localeLabel = (code: Locale) => i18n.locales.find((entry) => entry.code === code)?.label ?? code
  return (
    <div class="settings-body">
      <SettingsGroup>
        <SettingsList>
          <SettingsRow title={t("settings.appearance.language")} description={t("settings.appearance.language.description")}>
            <Select
              data-action="settings-language"
              options={i18n.locales.map((entry) => entry.code)}
              current={i18n.locale()}
              value={(code) => code}
              label={localeLabel}
              onSelect={(code) => code && i18n.setLocale(code)}
              variant="secondary" size="small" triggerVariant="settings"
            />
          </SettingsRow>
        </SettingsList>
      </SettingsGroup>
    </div>
  )
}
