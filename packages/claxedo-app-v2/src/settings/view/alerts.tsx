import { For } from "solid-js"
import { useTranslator } from "@/i18n"
import { playSound, requestSystemNotifications, SOUNDS, type AlertKind, type SoundChoice } from "@/notifications"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@/ui"
import { dictionary, type Keys } from "../i18n"
import { usePreferences } from "../preferences"
import { SettingsGroup, SettingsList, SettingsRow } from "./section"

type AlertRow = { readonly kind: AlertKind; readonly title: Keys; readonly notify: Keys; readonly sound: Keys }

const ALERT_ROWS: readonly AlertRow[] = [
  { kind: "agent", title: "settings.alerts.agent", notify: "settings.notifications.agent.description", sound: "settings.sounds.agent.description" },
  {
    kind: "permissions",
    title: "settings.alerts.permissions",
    notify: "settings.notifications.permissions.description",
    sound: "settings.sounds.permissions.description",
  },
  { kind: "errors", title: "settings.alerts.errors", notify: "settings.notifications.errors.description", sound: "settings.sounds.errors.description" },
]

const SOUND_CHOICES: readonly SoundChoice[] = ["none", ...SOUNDS.map((sound) => sound.id)]

export function NotificationsSection() {
  const t = useTranslator(dictionary)
  const preferences = usePreferences()
  const change = (kind: AlertKind, checked: boolean) => {
    preferences.setAlertNotify(kind, checked)
    if (checked) void requestSystemNotifications()
  }
  return (
    <div class="settings-body">
      <SettingsGroup>
        <SettingsList>
          <For each={ALERT_ROWS}>
            {(row) => (
              <SettingsRow title={t(row.title)} description={t(row.notify)}>
                <div data-action={`settings-notifications-${row.kind}`}>
                  <Switch hideLabel checked={preferences.alerts.notify[row.kind]} onChange={(checked) => change(row.kind, checked)}>
                    {t(row.title)}
                  </Switch>
                </div>
              </SettingsRow>
            )}
          </For>
        </SettingsList>
      </SettingsGroup>
    </div>
  )
}

export function SoundsSection() {
  const t = useTranslator(dictionary)
  const preferences = usePreferences()
  const label = (choice: SoundChoice) => (choice === "none" ? t("settings.sounds.none") : t("settings.sounds.alert01"))
  return (
    <div class="settings-body">
      <SettingsGroup>
        <SettingsList>
          <For each={ALERT_ROWS}>
            {(row) => (
              <SettingsRow title={t(row.title)} description={t(row.sound)}>
                <Select
                  data-action={`settings-sounds-${row.kind}`}
                  options={[...SOUND_CHOICES]}
                  current={preferences.alerts.sound[row.kind]}
                  value={(choice) => choice}
                  label={label}
                  onHighlight={(choice) => {
                    if (choice) playSound(choice)
                  }}
                  onSelect={(choice) => {
                    if (!choice) return
                    preferences.setAlertSound(row.kind, choice)
                    playSound(choice)
                  }}
                  variant="secondary" size="small" triggerVariant="settings"
                />
              </SettingsRow>
            )}
          </For>
        </SettingsList>
      </SettingsGroup>
    </div>
  )
}
