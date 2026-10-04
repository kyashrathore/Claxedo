import { createContext, createSignal, useContext } from "solid-js"
import type { Registry, ShellRegistries } from "./types"

export function createRegistry<Entry>(initial: readonly Entry[]): Registry<Entry> {
  const [entries, setEntries] = createSignal(initial)
  return {
    list: entries,
    add: (entry) => {
      setEntries((current) => [...current, entry])
      return () => setEntries((current) => current.filter((candidate) => candidate !== entry))
    },
  }
}

export type FirstPartyEntries = {
  readonly [Key in keyof ShellRegistries]: ReturnType<ShellRegistries[Key]["list"]>
}

export function createShellRegistries(firstParty: FirstPartyEntries): ShellRegistries {
  return {
    pages: createRegistry(firstParty.pages),
    paneKinds: createRegistry(firstParty.paneKinds),
    panelViews: createRegistry(firstParty.panelViews),
    settingsSections: createRegistry(firstParty.settingsSections),
    sidebarItems: createRegistry(firstParty.sidebarItems),
    overlays: createRegistry(firstParty.overlays),
    commands: createRegistry(firstParty.commands),
    mentions: createRegistry(firstParty.mentions),
    themes: createRegistry(firstParty.themes),
    iconSkins: createRegistry(firstParty.iconSkins),
    routes: createRegistry(firstParty.routes),
  }
}

export function byOrder<Entry extends { readonly order?: number }>(entries: readonly Entry[]): readonly Entry[] {
  return [...entries].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

export const ShellRegistriesContext = createContext<ShellRegistries>()

export function useShellRegistries(): ShellRegistries {
  const registries = useContext(ShellRegistriesContext)
  if (!registries) throw new Error("useShellRegistries needs a ShellRegistriesContext provider above it")
  return registries
}
