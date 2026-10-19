import type {
  CommandsApi,
  IconsApi,
  MentionsApi,
  OverlaysApi,
  PagesApi,
  PanesApi,
  SettingsApi,
  SidebarApi,
  ThemesApi,
  WorkbenchApi,
} from "./contributions"
import type { I18nApi, PluginContext, ProjectsApi, ServerApi, SessionsApi, UiApi, WorkspacesApi } from "./host"
import type { TranscriptApi } from "./transcript"

export interface PluginApi {
  sidebar: SidebarApi
  pages: PagesApi
  panes: PanesApi
  settings: SettingsApi
  overlays: OverlaysApi
  commands: CommandsApi
  mentions: MentionsApi
  workbench: WorkbenchApi
  themes: ThemesApi
  icons: IconsApi
  transcript: TranscriptApi
  sessions: SessionsApi
  workspaces: WorkspacesApi
  projects: ProjectsApi
  server: ServerApi
  context: PluginContext
  ui: UiApi
  i18n: I18nApi
}
