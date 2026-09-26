import { createContext, useContext } from "solid-js"
import type { HarnessConfigStore } from "./harness-config-store"
import type { ModelNames } from "./model-names"
import type { ModelVisibility } from "./model-visibility"

export const HarnessConfigContext = createContext<HarnessConfigStore>()

export function useHarnessConfig(): HarnessConfigStore {
  const store = useContext(HarnessConfigContext)
  if (!store) throw new Error("useHarnessConfig needs a ComposerStoreProvider above it")
  return store
}

export type ModelPreferences = { readonly names: ModelNames; readonly visibility: ModelVisibility }

export const ModelPreferencesContext = createContext<ModelPreferences>()

export function useModelPreferences(): ModelPreferences {
  const preferences = useContext(ModelPreferencesContext)
  if (!preferences) throw new Error("useModelPreferences needs a ComposerStoreProvider above it")
  return preferences
}
