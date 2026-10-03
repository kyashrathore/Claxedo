import type { JSX } from "solid-js"

export type Disposer = () => void

export type IconName = string

export type Keybinding = string

export interface SidebarItem {
  id: string
  label: string
  pageId: string
  icon?: IconName
  order?: number
  badge?: () => string | number | undefined
}

export interface SidebarApi {
  item(item: SidebarItem): Disposer
}

export interface PageProps {
  path: string
  params: Readonly<Record<string, string>>
}

export interface PageDefinition {
  id: string
  path: string
  title: string
  render(props: PageProps): JSX.Element
}

export interface PagesApi {
  register(page: PageDefinition): Disposer
  open(pageId: string, params?: Readonly<Record<string, string>>): void
}

export interface PaneProps<State> {
  paneId: string
  state: State
  setState(next: State): void
  close(): void
}

export interface PaneRestore<State> {
  parse(raw: unknown): State | undefined
  serialize(state: State): unknown
}

export interface PaneDefinition<State> {
  kind: string
  title(state: State): string
  render(props: PaneProps<State>): JSX.Element
  restore: PaneRestore<State>
}

export interface PanesApi {
  register<State>(pane: PaneDefinition<State>): Disposer
  open<State>(kind: string, state: State): void
}

export interface SettingsSection {
  id: string
  title: string
  icon?: IconName
  order?: number
  render(): JSX.Element
}

export interface SettingsApi {
  section(section: SettingsSection): Disposer
}

export interface OverlayProps {
  close(): void
}

export interface OverlayDefinition {
  id: string
  keybinding: Keybinding
  render(props: OverlayProps): JSX.Element
}

export interface OverlaysApi {
  register(overlay: OverlayDefinition): Disposer
  open(overlayId: string): void
  close(overlayId: string): void
}

export interface CommandContext {
  sessionId?: string
  projectId?: string
}

export interface CommandDefinition {
  id: string
  title: string
  keybinding?: Keybinding
  category?: string
  enabled?(context: CommandContext): boolean
  run(context: CommandContext): void | Promise<void>
}

export interface CommandsApi {
  register(command: CommandDefinition): Disposer
  run(commandId: string): Promise<void>
}

export interface MentionItem {
  id: string
  label: string
  description?: string
  icon?: IconName
}

export interface MentionInsert {
  text: string
  attachment?: { kind: string; reference: string }
}

export interface MentionProvider {
  id: string
  label: string
  search(query: string, context: CommandContext): readonly MentionItem[] | Promise<readonly MentionItem[]>
  insert(item: MentionItem): MentionInsert
}

export interface MentionsApi {
  register(provider: MentionProvider): Disposer
}

export type WorkbenchTabStatus = "idle" | "working" | "running_in_background" | "attention" | "interrupted" | "done" | "failed"

export interface WorkbenchTab {
  id: string
  title: string
  kind: string
  status: WorkbenchTabStatus
  active: boolean
  index: number
}

export interface WorkbenchApi {
  tabs(): readonly WorkbenchTab[]
  activate(tabId: string): void
  close(tabId: string): void
  move(tabId: string, index: number): void
  onChanged(listener: (tabs: readonly WorkbenchTab[]) => void): Disposer
}

export type ThemeAppearance = "light" | "dark"

export interface ThemeDefinition {
  id: string
  name: string
  appearance: ThemeAppearance
  tokens: Readonly<Record<string, string>>
}

export interface ThemesApi {
  register(theme: ThemeDefinition): Disposer
}

export interface IconSkin {
  id: string
  name: string
  icons: Readonly<Record<IconName, () => JSX.Element>>
}

export interface IconsApi {
  registerSkin(skin: IconSkin): Disposer
}
