import type { Component, JSX } from "solid-js"

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }

export type Disposer = () => void

export type PageProps = { readonly params: Readonly<Record<string, string>> }

export type PageEntry = {
  readonly id: string
  readonly path: string
  readonly title: () => string
  readonly icon: string
  readonly sidebar: "main" | "settings"
  readonly order?: number
  readonly view: Component<PageProps>
}

export type PaneProps<State> = { readonly state: State; readonly paneId: string; readonly active: boolean }

export type PaneKind<State = Json> = {
  readonly kind: string
  readonly title: (state: State) => string
  readonly icon?: string
  readonly view: Component<PaneProps<State>>
  readonly encode: (state: State) => Json
  readonly decode: (value: Json) => State | undefined
}

export type PanelTab = {
  readonly id: string
  readonly title: () => string
  readonly icon: string
  readonly order?: number
  readonly when?: () => boolean
  readonly view: Component
}

export type SettingsSection = {
  readonly id: string
  readonly title: () => string
  readonly group: "account" | "workspace" | "app"
  readonly order?: number
  readonly view: Component
}

export type SidebarItem = {
  readonly id: string
  readonly title: () => string
  readonly icon: string
  readonly pageId: string
  readonly order?: number
}

export type OverlayEntry = {
  readonly id: string
  readonly keybinding?: string
  readonly view: Component<{ readonly close: () => void }>
}

export type CommandEntry = {
  readonly id: string
  readonly title: () => string
  readonly keybinding?: string
  readonly when?: () => boolean
  readonly run: () => void | Promise<void>
}

export type MentionEntry = {
  readonly id: string
  readonly label: string
  readonly group: string
  readonly insert: () => { readonly text: string } | { readonly attachment: { readonly kind: "text"; readonly text: string; readonly label: string } }
}

export type MentionSource = {
  readonly id: string
  readonly search: (query: string) => readonly MentionEntry[] | Promise<readonly MentionEntry[]>
}

export type ThemeEntry = {
  readonly id: string
  readonly name: string
  readonly tokens: Readonly<Record<string, string>>
}

export type IconSkin = {
  readonly id: string
  readonly icons: Readonly<Record<string, () => JSX.Element>>
}

export type Registry<Entry> = {
  readonly list: () => readonly Entry[]
  readonly add: (entry: Entry) => Disposer
}

export type ShellRegistries = {
  readonly pages: Registry<PageEntry>
  readonly paneKinds: Registry<PaneKind<never>>
  readonly panelTabs: Registry<PanelTab>
  readonly settingsSections: Registry<SettingsSection>
  readonly sidebarItems: Registry<SidebarItem>
  readonly overlays: Registry<OverlayEntry>
  readonly commands: Registry<CommandEntry>
  readonly mentions: Registry<MentionSource>
  readonly themes: Registry<ThemeEntry>
  readonly iconSkins: Registry<IconSkin>
}
