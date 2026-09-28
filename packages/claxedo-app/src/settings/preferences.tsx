import { createContext, createEffect, createRenderEffect, useContext, type JSX } from "solid-js"
import type { Store } from "solid-js/store"
import { persistedStore, preferenceKey } from "@/lib/persisted"
import { isRecord } from "@claxedo/helpers/guards"
import { DEFAULT_SOUND, isSoundChoice, type AlertKind, type AlertPreferences, type SoundChoice } from "@/notifications"
import { codeFontFamily, uiFontFamily } from "./fonts"

export type ContrastScheme = "light" | "dark"

export type ContrastLevels = Readonly<Record<ContrastScheme, number>>

export type TranscriptPreferences = {
  readonly showReasoningSummaries: boolean
  readonly shellToolPartsExpanded: boolean
  readonly editToolPartsExpanded: boolean
}

export type NavigatorSide = "left" | "right"

export type AppearancePreferences = {
  readonly navigatorSide: NavigatorSide
  readonly uiFont: string
  readonly codeFont: string
  readonly terminalFont: string
  readonly terminalScreenReader: boolean
}

export type Preferences = {
  readonly contrast: Store<ContrastLevels>
  readonly setContrast: (scheme: ContrastScheme, level: number) => void
  readonly transcript: Store<TranscriptPreferences>
  readonly setTranscript: <K extends keyof TranscriptPreferences>(key: K, value: TranscriptPreferences[K]) => void
  readonly appearance: Store<AppearancePreferences>
  readonly setAppearance: <K extends keyof AppearancePreferences>(key: K, value: AppearancePreferences[K]) => void
  readonly alerts: Store<AlertPreferences>
  readonly setAlertNotify: (kind: AlertKind, value: boolean) => void
  readonly setAlertSound: (kind: AlertKind, value: SoundChoice) => void
}

export const TRANSCRIPT_DEFAULTS: TranscriptPreferences = {
  showReasoningSummaries: false,
  shellToolPartsExpanded: false,
  editToolPartsExpanded: false,
}

export const CONTRAST_DEFAULTS: ContrastLevels = { light: 80, dark: 40 }

export function contrastLevel(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)))
}

function readContrast(value: unknown): ContrastLevels | undefined {
  if (!isRecord(value)) return undefined
  const level = (scheme: ContrastScheme) => {
    const stored = value[scheme]
    return typeof stored === "number" && Number.isFinite(stored) ? contrastLevel(stored) : CONTRAST_DEFAULTS[scheme]
  }
  return { light: level("light"), dark: level("dark") }
}

function readTranscript(value: unknown): TranscriptPreferences | undefined {
  if (!isRecord(value)) return undefined
  const flag = (key: keyof TranscriptPreferences) => (typeof value[key] === "boolean" ? value[key] : TRANSCRIPT_DEFAULTS[key])
  return {
    showReasoningSummaries: flag("showReasoningSummaries"),
    shellToolPartsExpanded: flag("shellToolPartsExpanded"),
    editToolPartsExpanded: flag("editToolPartsExpanded"),
  }
}

export const APPEARANCE_DEFAULTS: AppearancePreferences = {
  navigatorSide: "right",
  uiFont: "",
  codeFont: "",
  terminalFont: "",
  terminalScreenReader: false,
}

function readAppearance(value: unknown): AppearancePreferences | undefined {
  if (!isRecord(value)) return undefined
  const text = (key: "uiFont" | "codeFont" | "terminalFont") => (typeof value[key] === "string" ? value[key] : APPEARANCE_DEFAULTS[key])
  return {
    navigatorSide: value.navigatorSide === "left" ? "left" : "right",
    uiFont: text("uiFont"),
    codeFont: text("codeFont"),
    terminalFont: text("terminalFont"),
    terminalScreenReader: value.terminalScreenReader === true,
  }
}

export const ALERT_DEFAULTS: AlertPreferences = {
  notify: { agent: true, permissions: true, errors: true },
  sound: { agent: DEFAULT_SOUND, permissions: DEFAULT_SOUND, errors: DEFAULT_SOUND },
}

function readAlerts(value: unknown): AlertPreferences | undefined {
  if (!isRecord(value)) return undefined
  const notify = isRecord(value.notify) ? value.notify : {}
  const sound = isRecord(value.sound) ? value.sound : {}
  const flag = (kind: AlertKind) => (typeof notify[kind] === "boolean" ? notify[kind] : ALERT_DEFAULTS.notify[kind])
  const choice = (kind: AlertKind) => {
    const stored = sound[kind]
    return isSoundChoice(stored) ? stored : ALERT_DEFAULTS.sound[kind]
  }
  return {
    notify: { agent: flag("agent"), permissions: flag("permissions"), errors: flag("errors") },
    sound: { agent: choice("agent"), permissions: choice("permissions"), errors: choice("errors") },
  }
}

function writeFont(token: string, font: string, family: (font: string) => string): void {
  const root = document.documentElement.style
  if (font.trim()) root.setProperty(token, family(font))
  else root.removeProperty(token)
}

const PreferencesContext = createContext<Preferences>()

export function PreferencesProvider(props: { readonly children: JSX.Element }): JSX.Element {
  const [contrast, setContrast] = persistedStore(preferenceKey("appearance", "contrast"), CONTRAST_DEFAULTS, readContrast)
  const [transcript, setTranscript] = persistedStore(preferenceKey("general", "transcript"), TRANSCRIPT_DEFAULTS, readTranscript)
  const [appearance, setAppearance] = persistedStore(preferenceKey("appearance", "fonts"), APPEARANCE_DEFAULTS, readAppearance)
  const [alerts, setAlerts] = persistedStore(preferenceKey("alerts"), ALERT_DEFAULTS, readAlerts)
  createEffect(() => writeFont("--font-family-sans", appearance.uiFont, uiFontFamily))
  createEffect(() => writeFont("--font-family-mono", appearance.codeFont, codeFontFamily))
  createRenderEffect(() => {
    const style = document.documentElement.style
    style.setProperty("--claxedo-contrast-light", String(contrast.light))
    style.setProperty("--claxedo-contrast-dark", String(contrast.dark))
  })
  const preferences: Preferences = {
    contrast,
    setContrast: (scheme, level) => setContrast(scheme === "light" ? { light: contrastLevel(level) } : { dark: contrastLevel(level) }),
    transcript,
    setTranscript: (key, value) => setTranscript({ [key]: value }),
    appearance,
    setAppearance: (key, value) => setAppearance({ [key]: value }),
    alerts,
    setAlertNotify: (kind, value) => setAlerts({ notify: { ...alerts.notify, [kind]: value } }),
    setAlertSound: (kind, value) => setAlerts({ sound: { ...alerts.sound, [kind]: value } }),
  }
  return <PreferencesContext.Provider value={preferences}>{props.children}</PreferencesContext.Provider>
}

export function usePreferences(): Preferences {
  const preferences = useContext(PreferencesContext)
  if (!preferences) throw new Error("usePreferences needs a PreferencesProvider above it")
  return preferences
}
