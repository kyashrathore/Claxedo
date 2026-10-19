export type { PluginApi } from "./api"
export type { SessionRef } from "@claxedo/agent-runtime-contract"
export type {
  CommandContext,
  CommandDefinition,
  CommandsApi,
  Disposer,
  IconName,
  IconSkin,
  IconsApi,
  Keybinding,
  MentionInsert,
  MentionItem,
  MentionProvider,
  MentionsApi,
  OverlayDefinition,
  OverlayProps,
  OverlaysApi,
  PageDefinition,
  PageProps,
  RenderedPageDefinition,
  PagesApi,
  PaneDefinition,
  PaneProps,
  PaneRestore,
  PanesApi,
  SettingsApi,
  SettingsGroup,
  SettingsSection,
  SettingsSectionDefinition,
  SidebarApi,
  SidebarItem,
  SurfaceChannel,
  SurfacePageDefinition,
  SurfaceProgram,
  SurfaceSettingsSection,
  ThemeAppearance,
  ThemeDefinition,
  ThemesApi,
  WorkbenchApi,
  WorkbenchTab,
  WorkbenchTabStatus,
} from "./contributions"
export type {
  SurfaceActionDefinition,
  SurfaceActionEvent,
  SurfaceChildList,
  SurfaceComponent,
  SurfaceComponentName,
  SurfaceDataBinding,
  SurfaceDynamicValue,
  SurfaceMessage,
} from "./surface"
export { definePlugin } from "./define"
export type { PluginActivation, PluginDefinition } from "./define"
export type {
  Confirmation,
  CreateSessionInput,
  I18nApi,
  PluginContext,
  PluginPlatform,
  ProjectSummary,
  ProjectsApi,
  ServerApi,
  SessionAttachment,
  SessionStatus,
  SessionsApi,
  Toast,
  ToastKind,
  UiApi,
  WorkspaceStartResult,
  WorkspacesApi,
} from "./host"
export {
  PLUGIN_BACKEND_METHODS,
  PLUGIN_CAPABILITY_MAX_LENGTH,
  PLUGIN_CAPABILITY_PATTERN,
  PLUGIN_NAME_MAX_LENGTH,
  PLUGIN_SERVER_ROUTE_PREFIX,
  PluginManifestError,
  PluginStatusHooksRefusedError,
  isPluginCapability,
  pluginBackendRouteAllowed,
  pluginBackendSchema,
  pluginManifestSchema,
  pluginOperationAllowed,
  pluginPackageSchema,
  pluginRouteAllowed,
  pluginServerAccessSchema,
  readPluginManifest,
} from "./manifest"
export type { FirstPartyPluginId, PluginBackend, PluginCapability, PluginManifest, PluginServerAccess } from "./manifest"
export { isPluginId, PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN } from "./id"
export { FIRST_PARTY_PLUGIN_IDS, isFirstPartyPluginId } from "./manifest"
export { readToolCardTemplates, TOOL_CARD_MAX_TEMPLATES, TOOL_CARD_TONES, ToolCardTemplateError, toolCardTemplatesSchema } from "./transcript"
export type { ToolCardCondition, ToolCardFact, ToolCardLink, ToolCardRows, ToolCardStatus, ToolCardTemplate, ToolCardText, ToolCardTone, TranscriptApi } from "./transcript"
export { isPluginRuntimeModule, PLUGIN_RUNTIME_GLOBAL, PLUGIN_RUNTIME_MODULES } from "./runtime"
export type { PluginRuntime, PluginRuntimeModule } from "./runtime"

export { readStatusHookTemplates } from "./status-hooks"
export type { StatusHookTemplate, StatusHookEventRule } from "./status-hooks"
