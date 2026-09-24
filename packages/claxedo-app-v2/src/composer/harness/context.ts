import { createContext, useContext } from "solid-js"
import type { HarnessConfigStore } from "./harness-config-store"

export const HarnessConfigContext = createContext<HarnessConfigStore>()

export function useHarnessConfig(): HarnessConfigStore {
  const store = useContext(HarnessConfigContext)
  if (!store) throw new Error("useHarnessConfig needs a ComposerStoreProvider above it")
  return store
}
