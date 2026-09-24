import { For, Show } from "solid-js"
import { Select, Switch, TextInput } from "@/ui"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme"
import { useI18n, useTranslator, type Locale } from "@/i18n"
import { dictionary, type Keys } from "../i18n"
import { CODE_FONT_PLACEHOLDER, codeFontFamily, TERMINAL_FONT_PLACEHOLDER, terminalFontFamily, UI_FONT_PLACEHOLDER, uiFontFamily } from "../fonts"
import { usePreferences, type AppearancePreferences, type NavigatorSide } from "../preferences"
import { ContrastRow } from "./contrast"
import { SettingsGroup, SettingsList, SettingsRow } from "./section"

const SCHEMES: readonly ColorScheme[] = ["system", "light", "dark"]

const SCHEME_KEY = {
  system: "settings.appearance.scheme.system",
  light: "settings.appearance.scheme.light",
  dark: "settings.appearance.scheme.dark",
} as const satisfies Record<ColorScheme, string>

const SIDES: readonly NavigatorSide[] = ["left", "right"]

const SIDE_KEY = {
  left: "settings.appearance.navigatorSide.left",
  right: "settings.appearance.navigatorSide.right",
} as const satisfies Record<NavigatorSide, Keys>

type FontRow = {
  readonly key: "uiFont" | "codeFont" | "terminalFont"
  readonly title: Keys
  readonly description: Keys
  readonly placeholder: string
  readonly family: (font: string) => string
  readonly action: string
}

const FONT_ROWS: readonly FontRow[] = [
  { key: "uiFont", title: "settings.appearance.uiFont", description: "settings.appearance.uiFont.description", placeholder: UI_FONT_PLACEHOLDER, family: uiFontFamily, action: "settings-ui-font" },
  { key: "codeFont", title: "settings.appearance.codeFont", description: "settings.appearance.codeFont.description", placeholder: CODE_FONT_PLACEHOLDER, family: codeFontFamily, action: "settings-code-font" },
  {
    key: "terminalFont",
    title: "settings.appearance.terminalFont",
    description: "settings.appearance.terminalFont.description",
    placeholder: TERMINAL_FONT_PLACEHOLDER,
    family: terminalFontFamily,
    action: "settings-terminal-font",
  },
]

function FontRows(props: { readonly appearance: AppearancePreferences; readonly onChange: (key: FontRow["key"], value: string) => void }) {
  const t = useTranslator(dictionary)
  return (
    <For each={FONT_ROWS}>
      {(row) => (
        <SettingsRow title={t(row.title)} description={t(row.description)}>
          <TextInput
            data-action={row.action}
            aria-label={t(row.title)}
            value={props.appearance[row.key]}
            placeholder={row.placeholder}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            style={{ "font-family": row.family(props.appearance[row.key]) }}
            onInput={(event) => props.onChange(row.key, event.currentTarget.value)}
          />
        </SettingsRow>
      )}
    </For>
  )
}

export function AppearanceSection() {
  const t = useTranslator(dictionary)
  const i18n = useI18n()
  const theme = useTheme()
  const preferences = usePreferences()
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
          <Show when={theme.themeId() === "codex"}>
            <ContrastRow scheme="light" />
            <ContrastRow scheme="dark" />
          </Show>
          <SettingsRow title={t("settings.appearance.navigatorSide")} description={t("settings.appearance.navigatorSide.description")}>
            <Select
              data-action="settings-navigator-side"
              options={[...SIDES]}
              current={preferences.appearance.navigatorSide}
              value={(side) => side}
              label={(side) => t(SIDE_KEY[side])}
              onSelect={(side) => side && preferences.setAppearance("navigatorSide", side)}
            />
          </SettingsRow>
          <FontRows appearance={preferences.appearance} onChange={(key, value) => preferences.setAppearance(key, value)} />
          <SettingsRow title={t("settings.appearance.screenReader")} description={t("settings.appearance.screenReader.description")}>
            <div data-action="settings-terminal-screen-reader">
              <Switch
                hideLabel
                checked={preferences.appearance.terminalScreenReader}
                onChange={(checked) => preferences.setAppearance("terminalScreenReader", checked)}
              >
                {t("settings.appearance.screenReader")}
              </Switch>
            </div>
          </SettingsRow>
        </SettingsList>
      </SettingsGroup>
    </div>
  )
}
