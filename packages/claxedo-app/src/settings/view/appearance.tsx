import { For, Show } from "solid-js"
import { Select, Switch, useTheme, type ColorScheme, TextField } from "@/ui"
import { useTranslator } from "@/i18n"
import { settingsDictionary, type SettingsKey } from "../i18n"
import { CODE_FONT_PLACEHOLDER, codeFontFamily, TERMINAL_FONT_PLACEHOLDER, terminalFontFamily, UI_FONT_PLACEHOLDER, uiFontFamily } from "../fonts"
import { NAVIGATOR_SIDES, usePreferences, type AppearancePreferences, type NavigatorSide } from "../preferences"
import { ContrastRow } from "./contrast"
import { SettingsGroup, SettingsList, SettingsRow } from "./section"
import { TranscriptRows } from "./transcript-rows"

const SCHEMES: readonly ColorScheme[] = ["system", "light", "dark"]

const SCHEME_KEY = {
  system: "settings.appearance.scheme.system",
  light: "settings.appearance.scheme.light",
  dark: "settings.appearance.scheme.dark",
} as const satisfies Record<ColorScheme, string>

const SIDE_KEY = {
  left: "settings.appearance.navigatorSide.left",
  right: "settings.appearance.navigatorSide.right",
} as const satisfies Record<NavigatorSide, SettingsKey>

type FontRow = {
  readonly key: "uiFont" | "codeFont" | "terminalFont"
  readonly title: SettingsKey
  readonly description: SettingsKey
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

function FontRows(props: {
  readonly rows: readonly FontRow[]
  readonly appearance: AppearancePreferences
  readonly onChange: (key: FontRow["key"], value: string) => void
}) {
  const t = useTranslator(settingsDictionary)
  return (
    <For each={props.rows}>
      {(row) => (
        <SettingsRow title={t(row.title)} description={t(row.description)}>
          <div class="settings-font-field">
            <TextField
              data-action={row.action}
              label={t(row.title)}
              hideLabel
              value={props.appearance[row.key]}
              placeholder={row.placeholder}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              style={{ "font-family": row.family(props.appearance[row.key]) }}
              onChange={(value) => props.onChange(row.key, value)}
            />
          </div>
        </SettingsRow>
      )}
    </For>
  )
}

export function AppearanceSection() {
  const t = useTranslator(settingsDictionary)
  const theme = useTheme()
  const preferences = usePreferences()
  const setFont = (key: FontRow["key"], value: string) => preferences.setAppearance(key, value)
  const fontRows = (keys: readonly FontRow["key"][]) => FONT_ROWS.filter((row) => keys.includes(row.key))

  return (
    <div class="settings-body">
      <SettingsGroup title={t("settings.appearance.group.colors")}>
        <SettingsList>
          <SettingsRow title={t("settings.appearance.colorScheme")} description={t("settings.appearance.colorScheme.description")}>
            <Select
              data-action="settings-color-scheme"
              options={[...SCHEMES]}
              current={theme.colorScheme()}
              value={(scheme) => scheme}
              label={(scheme) => t(SCHEME_KEY[scheme])}
              onSelect={(scheme) => scheme && theme.setColorScheme(scheme)}
              appearance="inline"
            />
          </SettingsRow>
          <SettingsRow title={t("settings.appearance.theme")} description={t("settings.appearance.theme.description")}>
            <Select
              data-action="settings-theme"
              options={theme.ids()}
              current={theme.themeId()}
              value={(id) => id}
              label={(id) => theme.name(id)}
              onSelect={(id) => id && theme.setTheme(id)}
              appearance="inline"
            />
          </SettingsRow>
          <Show when={theme.themeId() === "codex"}>
            <ContrastRow scheme="light" />
            <ContrastRow scheme="dark" />
          </Show>
        </SettingsList>
      </SettingsGroup>
      <SettingsGroup title={t("settings.appearance.group.fonts")}>
        <SettingsList>
          <FontRows rows={fontRows(["uiFont", "codeFont"])} appearance={preferences.appearance} onChange={setFont} />
        </SettingsList>
      </SettingsGroup>
      <SettingsGroup title={t("settings.appearance.group.transcript")}>
        <SettingsList>
          <TranscriptRows />
        </SettingsList>
      </SettingsGroup>
      <SettingsGroup title={t("settings.appearance.group.panel")}>
        <SettingsList>
          <SettingsRow title={t("settings.appearance.navigatorSide")} description={t("settings.appearance.navigatorSide.description")}>
            <Select
              data-action="settings-navigator-side"
              options={[...NAVIGATOR_SIDES]}
              current={preferences.appearance.navigatorSide}
              value={(side) => side}
              label={(side) => t(SIDE_KEY[side])}
              onSelect={(side) => side && preferences.setAppearance("navigatorSide", side)}
              appearance="inline"
            />
          </SettingsRow>
        </SettingsList>
      </SettingsGroup>
      <SettingsGroup title={t("settings.appearance.group.terminal")}>
        <SettingsList>
          <FontRows rows={fontRows(["terminalFont"])} appearance={preferences.appearance} onChange={setFont} />
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
