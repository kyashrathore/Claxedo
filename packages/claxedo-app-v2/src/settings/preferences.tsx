import { createContext, createEffect, useContext, type JSX } from "solid-js"
import type { Store } from "solid-js/store"
import { persistedStore, preferenceKey } from "@/lib/persisted"
import { isRecord } from "@/lib/record"

export type ContrastScheme = "light" | "dark"

export type ContrastLevels = Readonly<Record<ContrastScheme, number>>

export type Preferences = {
  readonly contrast: Store<ContrastLevels>
  readonly setContrast: (scheme: ContrastScheme, level: number) => void
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

const PreferencesContext = createContext<Preferences>()

export function PreferencesProvider(props: { readonly children: JSX.Element }): JSX.Element {
  const [contrast, setContrast] = persistedStore<ContrastLevels>(preferenceKey("appearance", "contrast"), CONTRAST_DEFAULTS, readContrast)
  createEffect(() => {
    const style = document.documentElement.style
    style.setProperty("--claxedo-contrast-light", String(contrast.light))
    style.setProperty("--claxedo-contrast-dark", String(contrast.dark))
  })
  const preferences: Preferences = {
    contrast,
    setContrast: (scheme, level) => setContrast(scheme === "light" ? { light: contrastLevel(level) } : { dark: contrastLevel(level) }),
  }
  return <PreferencesContext.Provider value={preferences}>{props.children}</PreferencesContext.Provider>
}

export function usePreferences(): Preferences {
  const preferences = useContext(PreferencesContext)
  if (!preferences) throw new Error("usePreferences needs a PreferencesProvider above it")
  return preferences
}
