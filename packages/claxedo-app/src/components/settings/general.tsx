// Claxedo keeps this general settings override for analytics events and hosted account controls.

import { Component, createMemo, onMount, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useTheme, type ColorScheme } from "@opencode-ai/ui/theme/context"
import { useLanguage } from "@claxedo/context/language"
import { usePlatform } from "@claxedo/context/platform"
import {
  monoDefault,
  monoFontFamily,
  monoInput,
  sansDefault,
  sansFontFamily,
  sansInput,
  terminalDefault,
  terminalFontFamily,
  terminalInput,
  useSettings,
} from "@/context/settings"
import { playSoundById, SOUND_OPTIONS } from "@/utils/sound"
import { requestNotificationPermission } from "@/utils/notification-permission"
import { capture as phCapture } from "@claxedo/analytics/posthog"
import { AccountSettingsSection } from "@claxedo/components/settings-account-section"
import { Can } from "../shell/auth/role"
import { Link } from "@/components/link"
import { SettingsList } from "@/components/settings-list"

type ThemeOption = {
  id: string
  name: string
}

let demoSoundState = {
  cleanup: undefined as (() => void) | undefined,
  timeout: undefined as NodeJS.Timeout | undefined,
  run: 0,
}

// To prevent audio from overlapping/playing very quickly when navigating the settings menus,
// delay the playback by 100ms during quick selection changes and pause existing sounds.
const stopDemoSound = () => {
  demoSoundState.run += 1
  if (demoSoundState.cleanup) {
    demoSoundState.cleanup()
  }
  clearTimeout(demoSoundState.timeout)
  demoSoundState.cleanup = undefined
}

const playDemoSound = (id: string | undefined) => {
  stopDemoSound()
  if (!id) return

  const run = ++demoSoundState.run
  demoSoundState.timeout = setTimeout(() => {
    void playSoundById(id).then((cleanup) => {
      if (demoSoundState.run !== run) {
        cleanup?.()
        return
      }
      demoSoundState.cleanup = cleanup
    })
  }, 100)
}

export const SettingsGeneral: Component = () => {
  const theme = useTheme()
  const language = useLanguage()
  const platform = usePlatform()
  const settings = useSettings()

  onMount(() => {
    void theme.loadThemes()
  })

  const [store, setStore] = createStore({
    checking: false,
  })

  const check = () => {
    if (!platform.checkUpdate) return
    setStore("checking", true)
    phCapture("update_checked")

    void platform
      .checkUpdate()
      .then((result) => {
        if (!result.updateAvailable) {
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("settings.updates.toast.latest.title"),
            description: language.t("settings.updates.toast.latest.description", { version: platform.version ?? "" }),
          })
          return
        }

        const actions = platform.updateAndRestart
          ? [
              {
                label: language.t("toast.update.action.installRestart"),
                onClick: async () => {
                  phCapture("update_installed", { version: result.version })
                  await platform.updateAndRestart!()
                },
              },
              {
                label: language.t("toast.update.action.notYet"),
                onClick: "dismiss" as const,
              },
            ]
          : [
              {
                label: language.t("toast.update.action.notYet"),
                onClick: "dismiss" as const,
              },
            ]

        showToast({
          persistent: true,
          icon: "download",
          title: language.t("toast.update.title"),
          description: language.t("toast.update.description", { version: result.version ?? "" }),
          actions,
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
      .finally(() => setStore("checking", false))
  }

  const languageOptions = createMemo(() =>
    language.locales.map((locale) => ({
      value: locale,
      label: language.label(locale),
    })),
  )
  const followupOptions = createMemo((): { value: "queue" | "steer"; label: string }[] => [
    { value: "queue", label: language.t("settings.general.row.followup.option.queue") },
    { value: "steer", label: language.t("settings.general.row.followup.option.steer") },
  ])

  const themeOptions = createMemo<ThemeOption[]>(() => theme.ids().map((id) => ({ id, name: theme.name(id) })))
  const colorSchemeOptions = createMemo((): { value: ColorScheme; label: string }[] => [
    { value: "system", label: language.t("theme.scheme.system") },
    { value: "light", label: language.t("theme.scheme.light") },
    { value: "dark", label: language.t("theme.scheme.dark") },
  ])
  const soundOptions = [...SOUND_OPTIONS]
  const mono = () => monoInput(settings.appearance.font())
  const sans = () => sansInput(settings.appearance.uiFont())
  const terminal = () => terminalInput(settings.appearance.terminalFont())

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.tab.general")}</h2>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full">
        {/* Language Section */}
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.row.language.title")}</h3>

          <div class="bg-surface-raised-base px-4 rounded-lg">
            <SettingsRow
              title={language.t("settings.general.row.language.title")}
              description={language.t("settings.general.row.language.description")}
            >
              <Select
                data-action="settings-language"
                options={languageOptions()}
                current={languageOptions().find((o) => o.value === language.locale())}
                value={(o) => o.value}
                label={(o) => o.label}
                onSelect={(option) => {
                  if (!option) return
                  phCapture("setting_changed", { setting: "language", value: option.value })
                  language.setLocale(option.value)
                }}
                variant="secondary"
                size="small"
                triggerVariant="settings"
              />
            </SettingsRow>
          </div>
        </div>

        <div class="flex flex-col gap-1">
          <div class="bg-surface-raised-base px-4 rounded-lg">
            <SettingsRow
              title={language.t("settings.general.row.reasoningSummaries.title")}
              description={language.t("settings.general.row.reasoningSummaries.description")}
            >
              <div data-action="settings-feed-reasoning-summaries">
                <Switch
                  checked={settings.general.showReasoningSummaries()}
                  onChange={(checked) => {
                    phCapture("setting_changed", { setting: "show_reasoning_summaries", value: checked })
                    settings.general.setShowReasoningSummaries(checked)
                  }}
                />
              </div>
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.row.shellToolPartsExpanded.title")}
              description={language.t("settings.general.row.shellToolPartsExpanded.description")}
            >
              <div data-action="settings-feed-shell-tool-parts-expanded">
                <Switch
                  checked={settings.general.shellToolPartsExpanded()}
                  onChange={(checked) => {
                    phCapture("setting_changed", { setting: "shell_tool_parts_expanded", value: checked })
                    settings.general.setShellToolPartsExpanded(checked)
                  }}
                />
              </div>
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.row.editToolPartsExpanded.title")}
              description={language.t("settings.general.row.editToolPartsExpanded.description")}
            >
              <div data-action="settings-feed-edit-tool-parts-expanded">
                <Switch
                  checked={settings.general.editToolPartsExpanded()}
                  onChange={(checked) => {
                    phCapture("setting_changed", { setting: "edit_tool_parts_expanded", value: checked })
                    settings.general.setEditToolPartsExpanded(checked)
                  }}
                />
              </div>
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.row.followup.title")}
              description={language.t("settings.general.row.followup.description")}
            >
              <Select
                data-action="settings-followup"
                options={followupOptions()}
                current={followupOptions().find((o) => o.value === settings.general.followup())}
                value={(o) => o.value}
                label={(o) => o.label}
                onSelect={(option) => {
                  if (!option) return
                  phCapture("setting_changed", { setting: "followup", value: option.value })
                  settings.general.setFollowup(option.value)
                }}
                variant="secondary"
                size="small"
                triggerVariant="settings"
                triggerStyle={{ "min-width": "180px" }}
              />
            </SettingsRow>
          </div>
        </div>

        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.appearance")}</h3>

          <SettingsList>
            <SettingsRow
              title={language.t("settings.general.row.colorScheme.title")}
              description={language.t("settings.general.row.colorScheme.description")}
            >
              <Select
                data-action="settings-color-scheme"
                options={colorSchemeOptions()}
                current={colorSchemeOptions().find((o) => o.value === theme.colorScheme())}
                value={(o) => o.value}
                label={(o) => o.label}
                onSelect={(option) => option && theme.setColorScheme(option.value)}
                onHighlight={(option) => {
                  if (!option) return
                  theme.previewColorScheme(option.value)
                  return () => theme.cancelPreview()
                }}
                variant="secondary"
                size="small"
                triggerVariant="settings"
                triggerStyle={{ "min-width": "220px" }}
              />
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.row.theme.title")}
              description={
                <>
                  {language.t("settings.general.row.theme.description")}{" "}
                  <Link href="https://opencode.ai/docs/themes/">{language.t("common.learnMore")}</Link>
                </>
              }
            >
              <Select
                data-action="settings-theme"
                options={themeOptions()}
                current={themeOptions().find((o) => o.id === theme.themeId())}
                value={(o) => o.id}
                label={(o) => o.name}
                onSelect={(option) => {
                  if (!option) return
                  theme.setTheme(option.id)
                }}
                onHighlight={(option) => {
                  if (!option) return
                  theme.previewTheme(option.id)
                  return () => theme.cancelPreview()
                }}
                variant="secondary"
                size="small"
                triggerVariant="settings"
              />
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.row.uiFont.title")}
              description={language.t("settings.general.row.uiFont.description")}
            >
              <div class="w-full sm:w-[220px]">
                <TextField
                  data-action="settings-ui-font"
                  label={language.t("settings.general.row.uiFont.title")}
                  hideLabel
                  type="text"
                  value={sans()}
                  onChange={(value) => settings.appearance.setUIFont(value)}
                  placeholder={sansDefault}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  class="text-12-regular"
                  style={{ "font-family": sansFontFamily(settings.appearance.uiFont()) }}
                />
              </div>
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.row.font.title")}
              description={language.t("settings.general.row.font.description")}
            >
              <div class="w-full sm:w-[220px]">
                <TextField
                  data-action="settings-code-font"
                  label={language.t("settings.general.row.font.title")}
                  hideLabel
                  type="text"
                  value={mono()}
                  onChange={(value) => settings.appearance.setFont(value)}
                  placeholder={monoDefault}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  class="text-12-regular"
                  style={{ "font-family": monoFontFamily(settings.appearance.font()) }}
                />
              </div>
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.row.terminalFont.title")}
              description={language.t("settings.general.row.terminalFont.description")}
            >
              <div class="w-full sm:w-[220px]">
                <TextField
                  data-action="settings-terminal-font"
                  label={language.t("settings.general.row.terminalFont.title")}
                  hideLabel
                  type="text"
                  value={terminal()}
                  onChange={(value) => settings.appearance.setTerminalFont(value)}
                  placeholder={terminalDefault}
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  class="text-12-regular"
                  style={{ "font-family": terminalFontFamily(settings.appearance.terminalFont()) }}
                />
              </div>
            </SettingsRow>
          </SettingsList>
        </div>

        {/* System notifications Section */}
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.notifications")}</h3>

          <div class="bg-surface-raised-base px-4 rounded-lg">
            <SettingsRow
              title={language.t("settings.general.notifications.agent.title")}
              description={language.t("settings.general.notifications.agent.description")}
            >
              <div data-action="settings-notifications-agent">
                <Switch
                  checked={settings.notifications.agent()}
                  onChange={(checked) => {
                    phCapture("setting_changed", { setting: "notification_agent", value: checked })
                    settings.notifications.setAgent(checked)
                    // Request browser notification permission from THIS user
                    // gesture only — never from turn completion (see
                    // src/utils/notification-permission.ts). No-ops once the
                    // user has already granted/denied it.
                    if (checked) void requestNotificationPermission()
                  }}
                />
              </div>
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.notifications.permissions.title")}
              description={language.t("settings.general.notifications.permissions.description")}
            >
              <div data-action="settings-notifications-permissions">
                <Switch
                  checked={settings.notifications.permissions()}
                  onChange={(checked) => {
                    phCapture("setting_changed", { setting: "notification_permissions", value: checked })
                    settings.notifications.setPermissions(checked)
                  }}
                />
              </div>
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.notifications.errors.title")}
              description={language.t("settings.general.notifications.errors.description")}
            >
              <div data-action="settings-notifications-errors">
                <Switch
                  checked={settings.notifications.errors()}
                  onChange={(checked) => {
                    phCapture("setting_changed", { setting: "notification_errors", value: checked })
                    settings.notifications.setErrors(checked)
                    // See settings-notifications-agent above.
                    if (checked) void requestNotificationPermission()
                  }}
                />
              </div>
            </SettingsRow>
          </div>
        </div>

        {/* Sound effects Section */}
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.sounds")}</h3>

          <div class="bg-surface-raised-base px-4 rounded-lg">
            <SettingsRow
              title={language.t("settings.general.sounds.agent.title")}
              description={language.t("settings.general.sounds.agent.description")}
            >
              <Select
                data-action="settings-sounds-agent"
                options={soundOptions}
                current={soundOptions.find((o) => o.id === settings.sounds.agent())}
                value={(o) => o.id}
                label={(o) => language.t(o.label)}
                onHighlight={(option) => {
                  if (!option) return
                  playDemoSound(option.id)
                }}
                onSelect={(option) => {
                  if (!option) return
                  phCapture("setting_changed", { setting: "sound_agent", value: option.id })
                  settings.sounds.setAgent(option.id)
                  playDemoSound(option.id)
                }}
                variant="secondary"
                size="small"
                triggerVariant="settings"
              />
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.sounds.permissions.title")}
              description={language.t("settings.general.sounds.permissions.description")}
            >
              <Select
                data-action="settings-sounds-permissions"
                options={soundOptions}
                current={soundOptions.find((o) => o.id === settings.sounds.permissions())}
                value={(o) => o.id}
                label={(o) => language.t(o.label)}
                onHighlight={(option) => {
                  if (!option) return
                  playDemoSound(option.id)
                }}
                onSelect={(option) => {
                  if (!option) return
                  phCapture("setting_changed", { setting: "sound_permissions", value: option.id })
                  settings.sounds.setPermissions(option.id)
                  playDemoSound(option.id)
                }}
                variant="secondary"
                size="small"
                triggerVariant="settings"
              />
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.sounds.errors.title")}
              description={language.t("settings.general.sounds.errors.description")}
            >
              <Select
                data-action="settings-sounds-errors"
                options={soundOptions}
                current={soundOptions.find((o) => o.id === settings.sounds.errors())}
                value={(o) => o.id}
                label={(o) => language.t(o.label)}
                onHighlight={(option) => {
                  if (!option) return
                  playDemoSound(option.id)
                }}
                onSelect={(option) => {
                  if (!option) return
                  phCapture("setting_changed", { setting: "sound_errors", value: option.id })
                  settings.sounds.setErrors(option.id)
                  playDemoSound(option.id)
                }}
                variant="secondary"
                size="small"
                triggerVariant="settings"
              />
            </SettingsRow>
          </div>
        </div>

        {/* Updates Section */}
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.general.section.updates")}</h3>

          <div class="bg-surface-raised-base px-4 rounded-lg">
            <SettingsRow
              title={language.t("settings.updates.row.startup.title")}
              description={language.t("settings.updates.row.startup.description")}
            >
              <div data-action="settings-updates-startup">
                <Switch
                  checked={settings.updates.startup()}
                  disabled={!platform.checkUpdate}
                  onChange={(checked) => settings.updates.setStartup(checked)}
                />
              </div>
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.row.releaseNotes.title")}
              description={language.t("settings.general.row.releaseNotes.description")}
            >
              <div data-action="settings-release-notes">
                <Switch
                  checked={settings.general.releaseNotes()}
                  onChange={(checked) => settings.general.setReleaseNotes(checked)}
                />
              </div>
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.updates.row.check.title")}
              description={language.t("settings.updates.row.check.description")}
            >
              <Button
                size="small"
                variant="secondary"
                disabled={store.checking || !platform.checkUpdate}
                onClick={check}
              >
                {store.checking
                  ? language.t("settings.updates.action.checking")
                  : language.t("settings.updates.action.checkNow")}
              </Button>
            </SettingsRow>
          </div>
        </div>

        <Can do="view.account">
          <AccountSettingsSection t={language.t as (key: string) => string} />
        </Can>
      </div>
    </div>
  )
}

interface SettingsRowProps {
  title: string
  description: string | JSX.Element
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
      <div class="flex flex-col gap-0.5 min-w-0">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex-shrink-0">{props.children}</div>
    </div>
  )
}
