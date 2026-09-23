import { createEffect } from "solid-js"
import type { SetStoreFunction, Store } from "solid-js/store"
import { persistedStore, preferenceKey } from "@/lib/persisted"
import { readBoolean, readString } from "@/lib/record"
import { defaultAppearance, type AppearancePreferences } from "./model"

export type Appearance = {
  readonly prefs: Store<AppearancePreferences>
  readonly set: SetStoreFunction<AppearancePreferences>
}

function readAppearance(value: unknown): AppearancePreferences | undefined {
  if (typeof value !== "object" || value === null) return undefined
  return {
    uiFont: readString(value, "uiFont") ?? defaultAppearance.uiFont,
    codeFont: readString(value, "codeFont") ?? defaultAppearance.codeFont,
    terminalFont: readString(value, "terminalFont") ?? defaultAppearance.terminalFont,
    terminalScreenReader: readBoolean(value, "terminalScreenReader") ?? defaultAppearance.terminalScreenReader,
    reasoningSummaries: readBoolean(value, "reasoningSummaries") ?? defaultAppearance.reasoningSummaries,
    shellToolPartsExpanded: readBoolean(value, "shellToolPartsExpanded") ?? defaultAppearance.shellToolPartsExpanded,
    editToolPartsExpanded: readBoolean(value, "editToolPartsExpanded") ?? defaultAppearance.editToolPartsExpanded,
  }
}

const FONT_VARIABLES = {
  uiFont: "--font-family-sans",
  codeFont: "--font-family-mono",
  terminalFont: "--font-family-terminal",
} as const satisfies Partial<Record<keyof AppearancePreferences, string>>

export function createAppearance(): Appearance {
  const [prefs, set] = persistedStore<AppearancePreferences>(preferenceKey("settings", "appearance"), defaultAppearance, readAppearance)
  createEffect(() => {
    if (typeof document !== "object") return
    for (const [key, variable] of Object.entries(FONT_VARIABLES)) {
      const value = prefs[key as keyof typeof FONT_VARIABLES].trim()
      if (value) document.documentElement.style.setProperty(variable, value)
      else document.documentElement.style.removeProperty(variable)
    }
  })
  return { prefs, set }
}
