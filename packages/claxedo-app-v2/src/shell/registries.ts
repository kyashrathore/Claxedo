import { createContext, createSignal, useContext } from "solid-js"
import type {
  AnyPaneKind,
  CommandEntry,
  IconSkin,
  MentionSource,
  OverlayEntry,
  PageEntry,
  PanelTab,
  Registry,
  RouteEntry,
  SettingsSection,
  ShellRegistries,
  SidebarItem,
  ThemeEntry,
} from "./types"

export function createRegistry<Entry>(initial: readonly Entry[]): Registry<Entry> {
  const [entries, setEntries] = createSignal<readonly Entry[]>(initial)
  return {
    list: entries,
    add: (entry) => {
      setEntries((current) => [...current, entry])
      return () => setEntries((current) => current.filter((candidate) => candidate !== entry))
    },
  }
}

export type FirstPartyEntries = {
  readonly pages: readonly PageEntry[]
  readonly paneKinds: readonly AnyPaneKind[]
  readonly panelTabs: readonly PanelTab[]
  readonly settingsSections: readonly SettingsSection[]
  readonly sidebarItems: readonly SidebarItem[]
  readonly overlays: readonly OverlayEntry[]
  readonly commands: readonly CommandEntry[]
  readonly mentions: readonly MentionSource[]
  readonly themes: readonly ThemeEntry[]
  readonly iconSkins: readonly IconSkin[]
  readonly routes: readonly RouteEntry[]
}

export function createShellRegistries(firstParty: FirstPartyEntries): ShellRegistries {
  return {
    pages: createRegistry(firstParty.pages),
    paneKinds: createRegistry(firstParty.paneKinds),
    panelTabs: createRegistry(firstParty.panelTabs),
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
