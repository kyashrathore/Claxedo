import { For } from "solid-js"
import { useTranslator } from "@/i18n"
import { Switch } from "@/ui"
import { settingsDictionary, type SettingsKey } from "../i18n"
import { usePreferences, type TranscriptPreferences } from "../preferences"
import { SettingsRow } from "./section"

type TranscriptToggle = {
  readonly key: keyof TranscriptPreferences
  readonly title: SettingsKey
  readonly description: SettingsKey
  readonly action: string
}

const TRANSCRIPT_TOGGLES: readonly TranscriptToggle[] = [
  {
    key: "showReasoningSummaries",
    title: "settings.general.reasoningSummaries",
    description: "settings.general.reasoningSummaries.description",
    action: "settings-feed-reasoning-summaries",
  },
  {
    key: "shellToolPartsExpanded",
    title: "settings.general.shellToolPartsExpanded",
    description: "settings.general.shellToolPartsExpanded.description",
    action: "settings-feed-shell-tool-parts-expanded",
  },
  {
    key: "editToolPartsExpanded",
    title: "settings.general.editToolPartsExpanded",
    description: "settings.general.editToolPartsExpanded.description",
    action: "settings-feed-edit-tool-parts-expanded",
  },
]

export function TranscriptRows() {
  const t = useTranslator(settingsDictionary)
  const preferences = usePreferences()
  return (
    <For each={TRANSCRIPT_TOGGLES}>
      {(toggle) => (
        <SettingsRow title={t(toggle.title)} description={t(toggle.description)}>
          <div data-action={toggle.action}>
            <Switch hideLabel checked={preferences.transcript[toggle.key]} onChange={(checked) => preferences.setTranscript(toggle.key, checked)}>
              {t(toggle.title)}
            </Switch>
          </div>
        </SettingsRow>
      )}
    </For>
  )
}
