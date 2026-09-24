import type { Component, JSX } from "solid-js"
import type { PlacementId, ProjectId, SessionId, TerminalId } from "@/server"

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

export type PaneRoute =
  | { readonly kind: "draft"; readonly projectId: ProjectId; readonly placementId: PlacementId }
  | {
      readonly kind: "session"
      readonly projectId: ProjectId
      readonly placementId: PlacementId
      readonly sessionId: SessionId
    }
  | { readonly kind: "terminal"; readonly placementId: PlacementId; readonly terminalId: TerminalId }

export type PaneKind<State = Json> = {
  readonly kind: string
  readonly title: (state: State) => string
  readonly icon?: string
  readonly view: Component<PaneProps<State>>
  readonly encode: (state: State) => Json
  readonly decode: (value: Json) => State | undefined
  readonly fromRoute?: (route: PaneRoute) => State | undefined
  readonly toRoute?: (state: State) => PaneRoute | undefined
}

export type AnyPaneKind = {
  readonly kind: string
  readonly title: (state: never) => string
  readonly icon?: string
  readonly view: Component<PaneProps<never>>
  readonly encode: (state: never) => Json
  readonly decode: (value: Json) => unknown
  readonly fromRoute?: (route: PaneRoute) => unknown
  readonly toRoute?: (state: never) => PaneRoute | undefined
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
  readonly appearance?: "light" | "dark"
  readonly tokens: Readonly<Record<string, string>>
}

export type IconSkin = {
  readonly id: string
  readonly icons: Readonly<Record<string, () => JSX.Element>>
}

export type RouteEntry = {
  readonly id: string
  readonly path: string
  readonly view: Component<PageProps>
}

export type Registry<Entry> = {
  readonly list: () => readonly Entry[]
  readonly add: (entry: Entry) => Disposer
}

export type ShellRegistries = {
  readonly pages: Registry<PageEntry>
  readonly paneKinds: Registry<AnyPaneKind>
  readonly settingsSections: Registry<SettingsSection>
  readonly sidebarItems: Registry<SidebarItem>
  readonly overlays: Registry<OverlayEntry>
  readonly commands: Registry<CommandEntry>
  readonly mentions: Registry<MentionSource>
  readonly themes: Registry<ThemeEntry>
  readonly iconSkins: Registry<IconSkin>
  readonly routes: Registry<RouteEntry>
}
