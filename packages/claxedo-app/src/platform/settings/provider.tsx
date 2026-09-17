import { createStore, reconcile } from "solid-js/store"
import { createEffect, createMemo } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import {
  DEFAULT_TRANSCRIPT_TYPOGRAPHY,
  normalizeTranscriptTypography,
  type TranscriptPairing,
  type TranscriptTypography,
} from "@opencode-ai/ui/theme/transcript-typography"
import { persisted } from "@/platform/persistence/persist"
import { DEFAULT_SOUND_ID, isSoundID } from "@/platform/notifications/sound"
import { asRecord } from "@/lib/record"

export interface NotificationSettings {
  agent: boolean
  permissions: boolean
  errors: boolean
}

export interface SoundSettings {
  agentEnabled: boolean
  agent: string
  permissionsEnabled: boolean
  permissions: string
  errorsEnabled: boolean
  errors: string
}

export interface Settings {
  general: {
    autoSave: boolean
    releaseNotes: boolean
    followup: "queue" | "steer"
    showNavigation: boolean
    showSearch: boolean
    showReasoningSummaries: boolean
    shellToolPartsExpanded: boolean
    editToolPartsExpanded: boolean
    showSessionProgressBar: boolean
    timelineShowTurnTokens: boolean
  }
  updates: {
    startup: boolean
  }
  appearance: {
    mono: string
    sans: string
    terminal: string
    /** Faces, size and leading of the session transcript alone; the UI chrome keeps `sans`/`mono`. */
    transcript: TranscriptTypography
    /** Which side of the workspace panel the files navigator docks on. */
    navigatorSide: "left" | "right"
  }
  keybinds: Record<string, string>
  permissions: {
    autoApprove: boolean
  }
  notifications: NotificationSettings
  sounds: SoundSettings
}

export const monoDefault = "System Mono"
export const sansDefault = "System Sans"
export const terminalDefault = "JetBrainsMono Nerd Font Mono"

const monoFallback =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
const sansFallback = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const terminalFallback =
  '"JetBrainsMono Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

const monoBase = monoFallback
const sansBase = sansFallback
const terminalBase = terminalFallback

function input(font: string | undefined) {
  return font ?? ""
}

function family(font: string) {
  if (/^[\w-]+$/.test(font)) return font
  return `"${font.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function stack(font: string | undefined, base: string) {
  const value = font?.trim() ?? ""
  if (!value) return base
  return `${family(value)}, ${base}`
}

export function monoInput(font: string | undefined) {
  return input(font)
}

export function sansInput(font: string | undefined) {
  return input(font)
}

export function monoFontFamily(font: string | undefined) {
  return stack(font, monoBase)
}

export function sansFontFamily(font: string | undefined) {
  return stack(font, sansBase)
}

export function terminalInput(font: string | undefined) {
  return input(font)
}

export function terminalFontFamily(font: string | undefined) {
  return stack(font, terminalBase)
}

const defaultSettings: Settings = {
  general: {
    autoSave: true,
    releaseNotes: true,
    followup: "steer",
    showNavigation: false,
    showSearch: false,
    showReasoningSummaries: false,
    shellToolPartsExpanded: false,
    editToolPartsExpanded: false,
    showSessionProgressBar: true,
    timelineShowTurnTokens: false,
  },
  updates: {
    startup: true,
  },
  appearance: {
    mono: "",
    sans: "",
    terminal: "",
    transcript: DEFAULT_TRANSCRIPT_TYPOGRAPHY,
    navigatorSide: "right",
  },
  keybinds: {},
  permissions: {
    autoApprove: false,
  },
  notifications: {
    agent: true,
    permissions: true,
    errors: false,
  },
  sounds: {
    agentEnabled: true,
    agent: DEFAULT_SOUND_ID,
    permissionsEnabled: true,
    permissions: DEFAULT_SOUND_ID,
    errorsEnabled: true,
    errors: DEFAULT_SOUND_ID,
  },
}

export function migrateSettings(value: unknown) {
  const settings = asRecord(value)
  if (!settings) return value
  const stored = asRecord(settings.sounds)
  if (!stored) return value

  const invalid = (["agent", "permissions", "errors"] as const).filter(
    (key) => key in stored && !isSoundID(stored[key]),
  )
  if (invalid.length === 0) return value

  return {
    ...settings,
    sounds: {
      ...stored,
      ...Object.fromEntries(invalid.map((key) => [key, DEFAULT_SOUND_ID])),
    },
  }
}

function withFallback<T>(read: () => T | undefined, fallback: T) {
  return createMemo(() => read() ?? fallback)
}

const settingsContextInput = {
  name: "Settings", gate: true,
  init: () => {
    const [store, setStore, _, ready] = persisted(
      { key: "settings.v3", migrate: migrateSettings, sync: true },
      // A store writes into the object it is created from; the defaults must
      // survive for the fallbacks and for the next provider instance.
      createStore<Settings>(structuredClone(defaultSettings)),
    )

    // An inline token on <html> outranks a theme's `html[data-theme] { --font-family-sans }`,
    // so the property is written only while a font is actually chosen.
    createEffect(() => {
      if (typeof document === "undefined") return
      const root = document.documentElement
      const write = (token: string, font: string | undefined, family: (font: string) => string) => {
        if (font?.trim()) root.style.setProperty(token, family(font))
        else root.style.removeProperty(token)
      }
      write("--font-family-mono", store.appearance?.mono, monoFontFamily)
      write("--font-family-sans", store.appearance?.sans, sansFontFamily)
    })

    createEffect(() => {
      if (store.general?.followup !== "queue") return
      setStore("general", "followup", "steer")
    })

    const transcript = createMemo(() => normalizeTranscriptTypography(store.appearance?.transcript))
    // A plain object write would merge into the stored record and keep the
    // overrides a pairing change is meant to clear.
    const writeTranscript = (next: TranscriptTypography) => setStore("appearance", "transcript", reconcile(next))

    return {
      ready,
      get current() {
        return store
      },
      general: {
        autoSave: withFallback(() => store.general?.autoSave, defaultSettings.general.autoSave),
        setAutoSave(value: boolean) {
          setStore("general", "autoSave", value)
        },
        releaseNotes: withFallback(() => store.general?.releaseNotes, defaultSettings.general.releaseNotes),
        setReleaseNotes(value: boolean) {
          setStore("general", "releaseNotes", value)
        },
        followup: withFallback(
          () => (store.general?.followup === "queue" ? "steer" : store.general?.followup),
          defaultSettings.general.followup,
        ),
        setFollowup(value: "queue" | "steer") {
          setStore("general", "followup", value === "queue" ? "steer" : value)
        },
        showNavigation: withFallback(() => store.general?.showNavigation, defaultSettings.general.showNavigation),
        setShowNavigation(value: boolean) {
          setStore("general", "showNavigation", value)
        },
        showSearch: withFallback(() => store.general?.showSearch, defaultSettings.general.showSearch),
        setShowSearch(value: boolean) {
          setStore("general", "showSearch", value)
        },
        showReasoningSummaries: withFallback(
          () => store.general?.showReasoningSummaries,
          defaultSettings.general.showReasoningSummaries,
        ),
        setShowReasoningSummaries(value: boolean) {
          setStore("general", "showReasoningSummaries", value)
        },
        shellToolPartsExpanded: withFallback(
          () => store.general?.shellToolPartsExpanded,
          defaultSettings.general.shellToolPartsExpanded,
        ),
        setShellToolPartsExpanded(value: boolean) {
          setStore("general", "shellToolPartsExpanded", value)
        },
        editToolPartsExpanded: withFallback(
          () => store.general?.editToolPartsExpanded,
          defaultSettings.general.editToolPartsExpanded,
        ),
        setEditToolPartsExpanded(value: boolean) {
          setStore("general", "editToolPartsExpanded", value)
        },
        timelineShowTurnTokens: withFallback(
          () => store.general?.timelineShowTurnTokens,
          defaultSettings.general.timelineShowTurnTokens,
        ),
        setTimelineShowTurnTokens(value: boolean) {
          setStore("general", "timelineShowTurnTokens", value)
        },
        showSessionProgressBar: withFallback(
          () => store.general?.showSessionProgressBar,
          defaultSettings.general.showSessionProgressBar,
        ),
        setShowSessionProgressBar(value: boolean) {
          setStore("general", "showSessionProgressBar", value)
        },
      },
      updates: {
        startup: withFallback(() => store.updates?.startup, defaultSettings.updates.startup),
        setStartup(value: boolean) {
          setStore("updates", "startup", value)
        },
      },
      appearance: {
        font: withFallback(() => store.appearance?.mono, defaultSettings.appearance.mono),
        setFont(value: string) {
          setStore("appearance", "mono", value.trim() ? value : "")
        },
        uiFont: withFallback(() => store.appearance?.sans, defaultSettings.appearance.sans),
        setUIFont(value: string) {
          setStore("appearance", "sans", value.trim() ? value : "")
        },
        terminalFont: withFallback(() => store.appearance?.terminal, defaultSettings.appearance.terminal),
        setTerminalFont(value: string) {
          setStore("appearance", "terminal", value.trim() ? value : "")
        },
        navigatorSide: withFallback(() => store.appearance?.navigatorSide, defaultSettings.appearance.navigatorSide),
        setNavigatorSide(value: "left" | "right") {
          setStore("appearance", "navigatorSide", value)
        },
        /** The stored choice; an absent pairing follows the theme's (see `useTranscriptTypography`). */
        transcript,
        /** `undefined` returns to the theme's pairing; either way every override is dropped. */
        setTranscriptPairing(pairing: TranscriptPairing | undefined) {
          writeTranscript(pairing ? { pairing } : {})
        },
        /** An `undefined` value returns that knob to following the pairing. */
        setTranscriptOverride(patch: Partial<Omit<TranscriptTypography, "pairing">>) {
          writeTranscript({ ...transcript(), ...patch })
        },
      },
      keybinds: {
        get: (action: string) => store.keybinds?.[action],
        set(action: string, keybind: string) {
          setStore("keybinds", action, keybind)
        },
        reset(action: string) {
          setStore("keybinds", (current) => {
            if (!Object.prototype.hasOwnProperty.call(current, action)) return current
            const next = { ...current }
            delete next[action]
            return next
          })
        },
        resetAll() {
          setStore("keybinds", reconcile({}))
        },
      },
      permissions: {
        autoApprove: withFallback(() => store.permissions?.autoApprove, defaultSettings.permissions.autoApprove),
        setAutoApprove(value: boolean) {
          setStore("permissions", "autoApprove", value)
        },
      },
      notifications: {
        agent: withFallback(() => store.notifications?.agent, defaultSettings.notifications.agent),
        setAgent(value: boolean) {
          setStore("notifications", "agent", value)
        },
        permissions: withFallback(() => store.notifications?.permissions, defaultSettings.notifications.permissions),
        setPermissions(value: boolean) {
          setStore("notifications", "permissions", value)
        },
        errors: withFallback(() => store.notifications?.errors, defaultSettings.notifications.errors),
        setErrors(value: boolean) {
          setStore("notifications", "errors", value)
        },
      },
      sounds: {
        agentEnabled: withFallback(() => store.sounds?.agentEnabled, defaultSettings.sounds.agentEnabled),
        setAgentEnabled(value: boolean) {
          setStore("sounds", "agentEnabled", value)
        },
        agent: withFallback(() => store.sounds?.agent, defaultSettings.sounds.agent),
        setAgent(value: string) {
          setStore("sounds", "agent", value)
        },
        permissionsEnabled: withFallback(
          () => store.sounds?.permissionsEnabled,
          defaultSettings.sounds.permissionsEnabled,
        ),
        setPermissionsEnabled(value: boolean) {
          setStore("sounds", "permissionsEnabled", value)
        },
        permissions: withFallback(() => store.sounds?.permissions, defaultSettings.sounds.permissions),
        setPermissions(value: string) {
          setStore("sounds", "permissions", value)
        },
        errorsEnabled: withFallback(() => store.sounds?.errorsEnabled, defaultSettings.sounds.errorsEnabled),
        setErrorsEnabled(value: boolean) {
          setStore("sounds", "errorsEnabled", value)
        },
        errors: withFallback(() => store.sounds?.errors, defaultSettings.sounds.errors),
        setErrors(value: string) {
          setStore("sounds", "errors", value)
        },
      },
    }
  },
}
export const { use: useSettings, provider: SettingsProvider } = createSimpleContext<ReturnType<typeof settingsContextInput.init>, Record<string, any>>(settingsContextInput)
