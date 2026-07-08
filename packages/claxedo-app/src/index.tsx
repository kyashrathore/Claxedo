/**
 * Claxedo Cloud Extension Package
 *
 * This package registers Claxedo providers, routes, and hooks.
 */

import { setExtensions } from "./extensions"
import { appExtensions } from "./extensions/app"
import { serverExtensions } from "./extensions/server"
import { initializeClerk } from "./utils/auth-client"

/**
 * Configuration for initializing Claxedo cloud extensions.
 */
export interface ClaxedoConfig {
  /** Convex deployment URL (e.g., https://xxx.convex.cloud) */
  convexUrl: string
  /** Base URL for auth endpoints (defaults to window.location.origin) */
  authBaseUrl: string
  /** Gateway URL for session proxying (e.g., http://127.0.0.1:3000) */
  gatewayUrl: string
  /** Enable auto-switching to cloud sessions (default: true) */
  cloudAutoSwitch?: boolean

  // ─────────────────────────────────────────────
  // PLUGGABLE FEATURE FLAGS
  // ─────────────────────────────────────────────

  /** Enable Clerk auth + claxedo server (default: false) */
  authEnabled?: boolean
  /** Allow cloud sandbox workspace creation (default: false) */
  sandboxEnabled?: boolean
  /** Show Global Chat sections in the rail (default: false) */
  globalChatEnabled?: boolean
  /** Direct Daytona API key for no-auth sandbox mode */
  daytonaApiKey?: string
  /** URL for the standalone claxedo-server (PTY, events, agent hooks) */
  claxedoServerUrl?: string
}

/**
 * Initialize Claxedo cloud extensions.
 *
 * Call this before rendering the app to register all cloud functionality.
 * Extensions are conditionally registered based on feature flags:
 * - authEnabled: Clerk auth + claxedo server
 * - sandboxEnabled: Cloud sandbox workspace creation
 * - globalChatEnabled: Global Chat rail sections
 * - daytonaApiKey: Direct Daytona API key for no-auth sandbox mode
 *
 * @example
 * ```tsx
 * await initClaxedo({
 *   convexUrl: import.meta.env.VITE_CONVEX_URL,
 *   authBaseUrl: window.location.origin,
 *   gatewayUrl: "http://127.0.0.1:3000",
 *   authEnabled: true,
 *   sandboxEnabled: true,
 *   globalChatEnabled: true,
 * })
 *
 * render(() => <App />, document.getElementById("root")!)
 * ```
 */
export function initClaxedo(config: ClaxedoConfig): void {
  const app = appExtensions(config)

  setExtensions({
    app,
    server: serverExtensions(config),
  })

  // Only initialize auth if authEnabled (fire-and-forget)
  if (config.authEnabled) {
    initializeClerk().catch(() => {})
  }
}

/**
 * Get the default Claxedo configuration from environment variables.
 */
export function getDefaultConfig(): ClaxedoConfig {
  const envString = (value: unknown) => (typeof value === "string" ? value : undefined)

  return {
    convexUrl: import.meta.env.VITE_CONVEX_URL ?? "",
    authBaseUrl: envString(import.meta.env.VITE_AUTH_BASE_URL) ?? window.location.origin,
    gatewayUrl: envString(import.meta.env.VITE_OPENCODE_BACKEND_URL) ?? "http://127.0.0.1:3000",
    cloudAutoSwitch: import.meta.env.VITE_CLOUD_AUTOSWITCH !== "false",

    // Feature flags - all default to false for standalone mode
    authEnabled: import.meta.env.VITE_AUTH_ENABLED === "true",
    sandboxEnabled: import.meta.env.VITE_SANDBOX_ENABLED === "true",
    globalChatEnabled: import.meta.env.VITE_GLOBAL_CHAT_ENABLED === "true",
    daytonaApiKey: envString(import.meta.env.VITE_DAYTONA_API_KEY),
    claxedoServerUrl: envString(import.meta.env.VITE_CLAXEDO_SERVER_URL) ?? "http://127.0.0.1:3001",
  }
}

// Re-export utilities and types for direct use
export { clerk as authClient, waitForClerk, initializeClerk, getAuthToken } from "./utils/auth-client"
export { useAuthSession } from "./shell/auth/auth-session"
export type { AuthSession, AuthSessionStatus } from "./shell/auth/auth-session"
export { PrincipalProvider } from "./shell/auth/principal-provider"
export { applyLayoutCommand } from "./shell/layout/commands"
export type { LayoutCommand } from "./shell/layout/commands"
export type { ClaxedoConfig as Config }

// Re-export extension factories for advanced use cases
export { appExtensions } from "./extensions/app"
export { serverExtensions } from "./extensions/server"

// Additional component exports (for direct imports)
export {
  CloudAutoSwitch,
  createCloudAutoSwitchProvider,
  type CloudAutoSwitchProps,
  DialogCreateCloudProject,
  AccountSettingsSection,
} from "./components"

// Additional page exports
export { default as LoginPage, type LoginPageProps } from "./pages/login"
export { default as PermissionsPage } from "./pages/permissions"
export { default as ConfigPage } from "./pages/config"

// Config context exports
export {
  ConfigProvider,
  useConfig,
  useConfigOptional,
  type ConfigProviderProps,
} from "./context"

// Re-export overridden contexts (use these instead of @opencode-ai/app versions)
export {
  useGlobalSync,
  GlobalSyncProvider,
} from "@/context/global-sync"
export {
  useGlobalSDK,
  GlobalSDKProvider,
} from "@/context/global-sdk"
export { useLayout, LayoutProvider, LayoutContext, getAvatarColors, type LocalProject } from "@/context/layout"
export { useServer, ServerProvider } from "@/context/server"
export { ServerConnection, normalizeServerUrl, serverName } from "@/context/server"
export { usePlatform, PlatformProvider, type Platform } from "@claxedo/context/platform"
export { useTerminal, TerminalProvider, type LocalPTY } from "@/context/terminal"
export { useSettings, SettingsProvider } from "@/context/settings"
export { useCommand, CommandProvider } from "@claxedo/context/command"
export {
  useLanguage,
  LanguageProvider,
  loadLocaleDict,
  normalizeLocale,
  type Locale,
} from "@claxedo/context/language"
export { useFile, FileProvider } from "@/context/file"
export { useComments, CommentsProvider } from "@/context/comments"
export { usePrompt, PromptProvider } from "@/context/prompt"
export { Persist, persisted } from "@/utils/persist"

// Re-export components
export { PromptInput } from "@/session-client/composer/composer"
export { Terminal } from "@/components/terminal"
export { Titlebar } from "@/components/titlebar"
export { DialogSettings } from "@/components/dialog-settings"
export { AppBaseProviders, AppInterface } from "./app"
export { handleNotificationClick } from "@/utils/notification-click"
