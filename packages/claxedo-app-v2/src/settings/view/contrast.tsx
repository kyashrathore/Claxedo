import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { settingsDictionary } from "../i18n"
import { usePreferences, type ContrastScheme } from "../preferences"
import { SettingsRow } from "./section"

const TITLE_KEY = {
  light: "settings.appearance.contrast.light",
  dark: "settings.appearance.contrast.dark",
} as const satisfies Record<ContrastScheme, string>

export function ContrastRow(props: { readonly scheme: ContrastScheme }): JSX.Element {
  const t = useTranslator(settingsDictionary)
  const preferences = usePreferences()
  const title = () => t(TITLE_KEY[props.scheme])
  return (
    <SettingsRow title={title()} description={t("settings.appearance.contrast.description")}>
      <div class="settings-contrast">
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          aria-label={title()}
          value={preferences.contrast[props.scheme]}
          onInput={(event) => preferences.setContrast(props.scheme, event.currentTarget.valueAsNumber)}
        />
        <output class="settings-contrast-value">{preferences.contrast[props.scheme]}</output>
      </div>
    </SettingsRow>
  )
}
