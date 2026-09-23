import type { Accessor } from "solid-js"
import type {
  CommandEntry,
  Disposer,
  IconSkin,
  Json,
  MentionSource,
  OverlayEntry,
  PageEntry,
  PaneKind,
  SettingsSection,
  SidebarItem,
  ThemeEntry,
} from "./entries"
import type { PluginUi } from "./ui"

export const PLUGIN_REQUIREMENTS = [
  "tasks",
  "documents",
  "cloud",
  "remoteAccess",
  "marketplace",
  "terminals",
  "browser",
  "sharing",
  "livePlugins",
] as const

export type PluginRequirement = (typeof PLUGIN_REQUIREMENTS)[number]

export type PluginManifest = {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly requires: readonly PluginRequirement[]
  readonly routes: readonly string[]
  readonly operations: readonly string[]
}

export type PluginModule = {
  readonly manifest: PluginManifest
  readonly activate: (api: PluginApi) => void | Promise<void>
}

export type ServerRequest = {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  readonly body?: Json
  readonly headers?: Readonly<Record<string, string>>
}

export type OperationResult = { readonly ok: boolean; readonly status: number; readonly body: unknown }

export type PluginServer = {
  readonly request: (input: ServerRequest) => Promise<Response>
  readonly operation: (name: string, input: Json, daemon: ServerRequest) => Promise<OperationResult>
}

export type WorkbenchTabStatus = "idle" | "working" | "waitingOnUser" | "failed" | "done"

export type WorkbenchTab = {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly status: WorkbenchTabStatus
  readonly active: boolean
  readonly closable: boolean
}

export type PluginWorkbench = {
  readonly tabs: Accessor<readonly WorkbenchTab[]>
  readonly activate: (tabId: string) => void
  readonly close: (tabId: string) => void
  readonly move: (tabId: string, index: number) => void
  readonly open: (kind: string, state: Json) => void
}

export type PromptAttachment =
  | { readonly kind: "file"; readonly path: string; readonly mime?: string }
  | { readonly kind: "image"; readonly dataUrl: string; readonly name?: string; readonly mime: string }
  | { readonly kind: "text"; readonly text: string; readonly label?: string }

export type SessionCreateRequest = {
  readonly placementId: string
  readonly text: string
  readonly attachments?: readonly PromptAttachment[]
  readonly harness?: string
  readonly title?: string
}

export type SessionLink = { readonly placementId: string; readonly sessionId: string }

export type SessionStatusKind = "idle" | "working" | "retrying" | "recovering" | "failed"

export type PluginSessions = {
  readonly create: (input: SessionCreateRequest) => Promise<SessionLink>
  readonly status: (link: SessionLink) => Accessor<SessionStatusKind | undefined>
  readonly open: (link: SessionLink) => void
}

export type PluginProject = { readonly id: string; readonly name: string }

export type PluginPlacement = {
  readonly id: string
  readonly projectId: string
  readonly kind: "folder" | "worktree" | "cloud"
  readonly label: string
}

export type PluginProjects = {
  readonly list: Accessor<readonly PluginProject[]>
  readonly currentId: Accessor<string | undefined>
  readonly currentPlacementId: Accessor<string | undefined>
  readonly placement: (id: string) => PluginPlacement | undefined
}

export type PluginUser = { readonly id: string; readonly name: string }

export type PluginContext = {
  readonly platform: "desktop" | "web"
  readonly features: Accessor<Readonly<Record<PluginRequirement, boolean>>>
  readonly signedIn: Accessor<boolean>
  readonly user: Accessor<PluginUser | undefined>
  readonly phone: Accessor<boolean>
  readonly language: Accessor<string>
}

export type PluginDictionary = Readonly<Record<string, string>>

export type PluginI18n = {
  readonly t: (key: string, params?: Readonly<Record<string, string | number>>) => string
  readonly add: (dictionaries: Readonly<Record<string, PluginDictionary>>) => Disposer
}

export type PluginPreferences = {
  readonly persisted: <Value extends Json>(key: string, initial: Value) => readonly [Accessor<Value>, (value: Value) => void]
}

export type PluginApi = {
  readonly id: string
  readonly sidebar: { readonly item: (item: SidebarItem) => Disposer }
  readonly pages: { readonly register: (page: PageEntry) => Disposer }
  readonly panes: { readonly register: <State extends Json>(kind: PaneKind<State>) => Disposer }
  readonly settings: { readonly section: (section: SettingsSection) => Disposer }
  readonly overlays: { readonly register: (overlay: OverlayEntry) => Disposer }
  readonly commands: { readonly register: (command: CommandEntry) => Disposer }
  readonly mentions: { readonly register: (source: MentionSource) => Disposer }
  readonly themes: { readonly register: (theme: ThemeEntry) => Disposer }
  readonly icons: { readonly registerSkin: (skin: IconSkin) => Disposer }
  readonly workbench: PluginWorkbench
  readonly sessions: PluginSessions
  readonly projects: PluginProjects
  readonly server: PluginServer
  readonly context: PluginContext
  readonly ui: PluginUi
  readonly i18n: PluginI18n
  readonly preferences: PluginPreferences
  readonly navigate: (path: string) => void
}

export function definePlugin(module: PluginModule): PluginModule {
  return module
}
