import type { Accessor, Component, JSX } from "solid-js"
import type { Capabilities, Placement, PlacementId, ProjectId, PromptAttachment, SessionId, SessionStatus } from "@/server"
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
} from "@/shell/types"

export type PluginRequirement = keyof Capabilities["features"]

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

export type PluginOrigin = { readonly kind: "bundled" } | { readonly kind: "live"; readonly bundleUrl: string }

export type ServerRequest = {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  readonly body?: Json
  readonly headers?: Readonly<Record<string, string>>
}

export type PluginServer = {
  readonly request: (input: ServerRequest) => Promise<Response>
  readonly operation: (name: string, input: Json, daemon: ServerRequest) => Promise<unknown>
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

export type SessionCreateRequest = {
  readonly placementId: PlacementId
  readonly text: string
  readonly attachments?: readonly PromptAttachment[]
  readonly harness?: string
  readonly title?: string
}

export type SessionLink = { readonly placementId: PlacementId; readonly sessionId: SessionId }

export type PluginSessions = {
  readonly create: (input: SessionCreateRequest) => Promise<SessionLink>
  readonly status: (link: SessionLink) => Accessor<SessionStatus | undefined>
  readonly open: (link: SessionLink) => void
}

export type PluginProject = { readonly id: ProjectId; readonly name: string }

export type PluginProjects = {
  readonly list: Accessor<readonly PluginProject[]>
  readonly currentId: Accessor<ProjectId | undefined>
  readonly currentPlacementId: Accessor<PlacementId | undefined>
  readonly placement: (id: PlacementId) => Placement | undefined
}

export type PluginContext = {
  readonly platform: "desktop" | "web"
  readonly capabilities: Accessor<Capabilities | undefined>
  readonly signedIn: Accessor<boolean>
  readonly phone: Accessor<boolean>
  readonly language: Accessor<string>
}

export type ToastInput = { readonly title: string; readonly description?: string; readonly tone?: "neutral" | "success" | "danger" }

export type ConfirmInput = {
  readonly title: string
  readonly description?: string
  readonly confirmLabel?: string
  readonly danger?: boolean
}

export type ButtonProps = {
  readonly variant?: "neutral" | "danger" | "outline" | "ghost" | "contrast"
  readonly size?: "small" | "normal" | "large"
  readonly icon?: string
  readonly disabled?: boolean
  readonly type?: "button" | "submit"
  readonly class?: string
  readonly "aria-label"?: string
  readonly "data-testid"?: string
  readonly onClick?: (event: MouseEvent) => void
  readonly children?: JSX.Element
}

export type IconButtonProps = {
  readonly icon: string
  readonly label: string
  readonly size?: "small" | "normal" | "large"
  readonly variant?: "neutral" | "ghost" | "danger"
  readonly disabled?: boolean
  readonly class?: string
  readonly "data-testid"?: string
  readonly onClick?: (event: MouseEvent) => void
}

export type IconProps = { readonly name: string; readonly size?: "small" | "normal" | "large"; readonly class?: string }

export type TextInputProps = {
  readonly value: string
  readonly onInput: (value: string) => void
  readonly label?: string
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly autofocus?: boolean
  readonly error?: string
  readonly class?: string
  readonly "aria-label"?: string
  readonly "data-testid"?: string
  readonly onKeyDown?: (event: KeyboardEvent) => void
}

export type TextareaProps = TextInputProps & { readonly rows?: number }

export type SelectOption = { readonly value: string; readonly label: string; readonly disabled?: boolean }

export type SelectProps = {
  readonly value: string | undefined
  readonly options: readonly SelectOption[]
  readonly onChange: (value: string) => void
  readonly label?: string
  readonly placeholder?: string
  readonly disabled?: boolean
  readonly class?: string
  readonly "aria-label"?: string
  readonly "data-testid"?: string
}

export type SwitchProps = {
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly label: string
  readonly disabled?: boolean
  readonly "data-testid"?: string
}

export type TabsProps = {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly tabs: readonly { readonly value: string; readonly label: string }[]
  readonly "aria-label": string
}

export type MenuItem = {
  readonly id: string
  readonly label: string
  readonly icon?: string
  readonly danger?: boolean
  readonly disabled?: boolean
  readonly onSelect: () => void
}

export type MenuProps = {
  readonly items: readonly MenuItem[]
  readonly label: string
  readonly trigger: JSX.Element
  readonly "data-testid"?: string
}

export type DialogProps = {
  readonly open: boolean
  readonly onClose: () => void
  readonly title: string
  readonly description?: string
  readonly footer?: JSX.Element
  readonly children?: JSX.Element
  readonly "data-testid"?: string
}

export type BadgeProps = { readonly tone?: "neutral" | "success" | "warning" | "danger"; readonly children?: JSX.Element }

export type TooltipProps = { readonly label: string; readonly children: JSX.Element }

export type LoaderProps = { readonly label: string }

export type PluginComponents = {
  readonly Button: Component<ButtonProps>
  readonly IconButton: Component<IconButtonProps>
  readonly Icon: Component<IconProps>
  readonly TextInput: Component<TextInputProps>
  readonly Textarea: Component<TextareaProps>
  readonly Select: Component<SelectProps>
  readonly Switch: Component<SwitchProps>
  readonly Tabs: Component<TabsProps>
  readonly Menu: Component<MenuProps>
  readonly Dialog: Component<DialogProps>
  readonly Badge: Component<BadgeProps>
  readonly Tooltip: Component<TooltipProps>
  readonly Loader: Component<LoaderProps>
}

export type PluginUi = {
  readonly toast: (input: ToastInput) => void
  readonly confirm: (input: ConfirmInput) => Promise<boolean>
  readonly components: PluginComponents
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
  readonly overlays: { readonly register: (overlay: OverlayEntry) => Disposer; readonly open: (id: string) => void }
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

export type PluginState =
  | { readonly kind: "off" }
  | { readonly kind: "loading"; readonly version: string }
  | { readonly kind: "on"; readonly version: string; readonly lastFailure?: PluginFailure }
  | { readonly kind: "swapping"; readonly version: string; readonly to: string }
  | { readonly kind: "failed"; readonly reason: string; readonly version: string }

export type PluginFailure = { readonly version: string; readonly reason: string }

export type PluginSummary = {
  readonly manifest: PluginManifest
  readonly origin: PluginOrigin
  readonly enabled: boolean
  readonly requiresMet: boolean
  readonly state: PluginState
}
