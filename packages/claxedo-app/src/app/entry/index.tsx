/**
 * Claxedo Cloud Extension Package
 *
 * This package registers Claxedo providers, routes, and hooks.
 */

import { setExtensions } from "../../features/extensions/index"
import { appExtensions } from "../../features/extensions/index"
import { serverExtensions } from "../../features/extensions/index"
import { DEFAULT_LOCAL_CLAXEDO_SERVER_URL } from "@/platform/api/local-server"
import { configureProductContributions, hostedContributionLoader } from "@/app/composition/product-contributions"
import {
  localContentSurfaces,
  registerContentSurface,
  unregisterContentSurface,
} from "@/app/integrations/first-party-content-surfaces"

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

  // `hostedComposition` answers "may this build ever hold hosted
  // contributions", which is what gates activation. It is NOT the account:
  // a hosted build serves unsigned windows too, and gating registration on a
  // signed account here would empty the composition of every window before
  // sign-in. Removal on sign-out is the account's half, and
  // `app/composition/hosted-contribution-sync.tsx` drives it.
  //
  // Unit 11 replaces this with the Electron account port's signed state, so a
  // signed desktop activates the same contribution entry from a real account
  // rather than a build-time environment variable — and the two halves become
  // one question.
  const contributions = configureProductContributions({
    local: localContentSurfaces,
    register: registerContentSurface,
    unregister: unregisterContentSurface,
    loadHosted: hostedContributionLoader(),
    hostedComposition: () => config.authEnabled === true,
  })

  // Starting the identity provider is NOT this function's job.
  //
  // It used to be, and that put Clerk in the import graph of every build that
  // calls `initClaxedo` — including the local one, which can never sign in.
  // Guarding it behind `config.authEnabled` did not help: the branch not
  // running does not remove the module from the bundle. Making it a dynamic
  // import only moved it to a lazy chunk that a local build still ships.
  //
  // So the hosted entry starts it (`app/entry/main.tsx`), which is where the
  // decision to have an identity provider is actually made, and this function
  // keeps only the parts both products share.
  if (config.authEnabled) {
    // Hosted composition: WorkGraph and Documents arrive as one lazily
    // imported contribution set rather than as static imports of this entry.
    //
    // `expectHosted()` runs synchronously and `activateHosted` resolves later,
    // and the split matters: restored-state pruning must know that WorkGraph
    // tabs are legal in this build BEFORE the dynamic import lands, or a hosted
    // reload would drop every restored WorkGraph tab in the gap.
    contributions.expectHosted()
    void contributions.activateHosted().catch(() => {})
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
    // Sandbox surfaces are always present now — the embedded runtime backs them
    // on every build, so there is no longer a VITE_SANDBOX_ENABLED gate.
    sandboxEnabled: true,
    globalChatEnabled: import.meta.env.VITE_GLOBAL_CHAT_ENABLED === "true",
    daytonaApiKey: envString(import.meta.env.VITE_DAYTONA_API_KEY),
    claxedoServerUrl: envString(import.meta.env.VITE_CLAXEDO_SERVER_URL) ?? DEFAULT_LOCAL_CLAXEDO_SERVER_URL,
  }
}

// The authenticated-identity surface lives on `@claxedo/app/auth`, not here.
// Re-exporting it from the main entry made Clerk a static edge of every build
// that imports this module for `getDefaultConfig` — including the local one,
// which can never sign in. See `entry/auth.ts`.
export { PrincipalProvider } from "@/platform/auth/principal-provider"
export { applyLayoutCommand } from "../layout/commands"
export type { LayoutCommand } from "../layout/commands"
export type { ClaxedoConfig as Config }

// Re-export extension factories for advanced use cases
export { appExtensions } from "../../features/extensions/index"
export { serverExtensions } from "../../features/extensions/index"

// Additional component exports (for direct imports)
export {
  CloudAutoSwitch,
  createCloudAutoSwitchProvider,
  type CloudAutoSwitchProps,
  DialogCreateCloudProject,
  AccountSettingsSection,
} from "../controls/index"

// Additional page exports
export { default as LoginPage, type LoginPageProps } from "../routes/login"
export { default as PermissionsPage } from "../routes/permissions"
export { default as ConfigPage } from "../routes/config"

// Config context exports
export {
  ConfigProvider,
  useConfig,
  useConfigOptional,
  type ConfigProviderProps,
} from "../providers/config"

// Re-export overridden contexts (use these instead of @opencode-ai/app versions)
export {
  useGlobalSync,
  GlobalSyncProvider,
} from "@/app/providers/global-sync/provider"
export {
  useGlobalSDK,
  GlobalSDKProvider,
} from "@/app/providers/global-sdk/provider"
export { useLayout, LayoutProvider, LayoutContext, getAvatarColors, type LocalProject } from "@/app/providers/layout"
export { useServer, ServerProvider } from "@/app/connection/server"
export { ServerConnection, normalizeServerUrl, serverName } from "@/app/connection/server"
export { usePlatform, PlatformProvider, type Platform } from "@/platform/runtime/platform-provider"
export { useTerminal, TerminalProvider, type LocalPTY } from "@/features/terminal/providers/provider"
export { useSettings, SettingsProvider } from "@/platform/settings/provider"
export { useCommand, CommandProvider } from "@/app/providers/command"
export {
  useLanguage,
  LanguageProvider,
  loadLocaleDict,
  normalizeLocale,
  type Locale,
} from "@/platform/i18n/provider"
export { useFile, FileProvider } from "@/app/providers/file"
export { useComments, CommentsProvider } from "@/platform/comments/provider"
export { usePrompt, PromptProvider } from "@/features/session/providers/prompt"
export { Persist, persisted } from "@/platform/persistence/persist"

// Re-export components
export { PromptInput } from "@/features/session/composer/composer"
export { Terminal } from "@/features/terminal/ui/terminal"
export { Titlebar } from "@/app/workbench/titlebar/titlebar"
export { DialogSettings } from "@/app/dialogs/settings"
export { AppBaseProviders, AppInterface } from "./app"
export { handleNotificationClick } from "@/platform/notifications/notification-click"
