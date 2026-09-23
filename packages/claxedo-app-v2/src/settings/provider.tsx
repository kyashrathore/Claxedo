import { createContext, useContext, type ParentProps } from "solid-js"
import { createAppearance, type Appearance } from "./preferences"
import { createAccounts, type Accounts } from "./store"

export type Settings = {
  readonly appearance: Appearance
  readonly accounts: Accounts
}

const SettingsContext = createContext<Settings>()

export function SettingsProvider(props: ParentProps) {
  const settings: Settings = { appearance: createAppearance(), accounts: createAccounts() }
  return <SettingsContext.Provider value={settings}>{props.children}</SettingsContext.Provider>
}

export function useSettings(): Settings {
  const settings = useContext(SettingsContext)
  if (!settings) throw new Error("useSettings needs a SettingsProvider above it")
  return settings
}
