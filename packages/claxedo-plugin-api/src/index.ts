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
  PagesApi,
  PaneDefinition,
  PaneProps,
  PaneRestore,
  PanesApi,
  SettingsApi,
  SettingsSection,
  SidebarApi,
  SidebarItem,
  ThemeAppearance,
  ThemeDefinition,
  ThemesApi,
  WorkbenchApi,
  WorkbenchTab,
  WorkbenchTabStatus,
} from "./contributions"
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
} from "./host"
export {
  PLUGIN_BACKEND_METHODS,
  PLUGIN_CAPABILITIES,
  PLUGIN_NAME_MAX_LENGTH,
  PLUGIN_SERVER_ROUTE_PREFIX,
  PluginManifestError,
  pluginBackendRouteAllowed,
  pluginBackendSchema,
  pluginManifestSchema,
  pluginOperationAllowed,
  pluginPackageSchema,
  pluginRouteAllowed,
  pluginServerAccessSchema,
  readPluginManifest,
} from "./manifest"
export type { PluginBackend, PluginCapability, PluginManifest, PluginServerAccess } from "./manifest"
export { isPluginId, PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN } from "./id"
export { isPluginRuntimeModule, PLUGIN_RUNTIME_GLOBAL, PLUGIN_RUNTIME_MODULES } from "./runtime"
export type { PluginRuntime, PluginRuntimeModule } from "./runtime"
