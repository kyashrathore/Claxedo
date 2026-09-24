import { createContext, createEffect, useContext, type JSX } from "solid-js"
import type { Store } from "solid-js/store"
import { persistedStore, preferenceKey } from "@/lib/persisted"
import { isRecord } from "@/lib/record"

export type ContrastScheme = "light" | "dark"

export type ContrastLevels = Readonly<Record<ContrastScheme, number>>

export type TranscriptPreferences = {
  readonly showReasoningSummaries: boolean
  readonly shellToolPartsExpanded: boolean
  readonly editToolPartsExpanded: boolean
}

export type Preferences = {
  readonly contrast: Store<ContrastLevels>
  readonly setContrast: (scheme: ContrastScheme, level: number) => void
  readonly transcript: Store<TranscriptPreferences>
  readonly setTranscript: <K extends keyof TranscriptPreferences>(key: K, value: TranscriptPreferences[K]) => void
}

export const TRANSCRIPT_DEFAULTS: TranscriptPreferences = {
  showReasoningSummaries: false,
  shellToolPartsExpanded: false,
  editToolPartsExpanded: false,
}

export const CONTRAST_DEFAULTS: ContrastLevels = { light: 40, dark: 100 }

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

const PreferencesContext = createContext<Preferences>()

export function PreferencesProvider(props: { readonly children: JSX.Element }): JSX.Element {
  const [contrast, setContrast] = persistedStore(preferenceKey("appearance", "contrast"), CONTRAST_DEFAULTS, readContrast)
  const [transcript, setTranscript] = persistedStore(preferenceKey("general", "transcript"), TRANSCRIPT_DEFAULTS, readTranscript)
  createEffect(() => {
    const style = document.documentElement.style
    style.setProperty("--claxedo-contrast-light", String(contrast.light))
    style.setProperty("--claxedo-contrast-dark", String(contrast.dark))
  })
  const preferences: Preferences = {
    contrast,
    setContrast: (scheme, level) => setContrast(scheme === "light" ? { light: contrastLevel(level) } : { dark: contrastLevel(level) }),
    transcript,
    setTranscript: (key, value) => setTranscript({ [key]: value }),
  }
  return <PreferencesContext.Provider value={preferences}>{props.children}</PreferencesContext.Provider>
}

export function usePreferences(): Preferences {
  const preferences = useContext(PreferencesContext)
  if (!preferences) throw new Error("usePreferences needs a PreferencesProvider above it")
  return preferences
}
