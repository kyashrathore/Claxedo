/**
 * Claxedo Cloud Extension Package
 *
 * This package registers Claxedo providers, routes, and hooks.
 */

import { setExtensions } from "../../features/extensions/index"
import { appExtensions } from "../../features/extensions/index"
import { serverExtensions } from "../../features/extensions/index"
import { DEFAULT_LOCAL_CLAXEDO_SERVER_URL } from "@/platform/api/local-server"
import { configureProductContributions, type HostedContributionLoader } from "@/app/composition/product-contributions"
import {
  configureServiceContributions,
  type ServiceContributionLoaders,
} from "@/app/composition/service-contributions"
import {
  localContentSurfaces,
  registerContentSurface,
  unregisterContentSurface,
} from "@/app/integrations/first-party-content-surfaces"
import {
  productUiFlagConfigFromEnv,
  type ProductUiFlagConfig,
} from "@/app/composition/product-ui-flags"

/**
 * Configuration for initializing Claxedo cloud extensions.
 */
export interface ClaxedoConfig extends ProductUiFlagConfig {
  /** Base URL for auth endpoints (defaults to window.location.origin) */
  authBaseUrl: string
  /** Gateway URL for session proxying (e.g., http://127.0.0.1:3000) */
  gatewayUrl: string
  /** Enable auto-switching to cloud sessions (default: true) */
  cloudAutoSwitch?: boolean

  // ─────────────────────────────────────────────
  // PLUGGABLE FEATURE FLAGS
  // ─────────────────────────────────────────────

  /** Allow cloud sandbox workspace creation (default: false) */
  sandboxEnabled?: boolean
  /** Show Global Chat sections in the rail (default: false) */
  globalChatEnabled?: boolean
  /** URL for the standalone claxedo-server (PTY, events, agent hooks) */
  claxedoServerUrl?: string
  /** Hosted product-owned implementation; absent from an unsigned artifact. */
  loadHostedContributions?: HostedContributionLoader
  /** Independently loaded fixed services, activated only by signed bootstrap. */
  serviceContributionLoaders?: ServiceContributionLoaders
}

/**
 * Initialize Claxedo cloud extensions.
 *
 * Call this before rendering the app to register all cloud functionality.
 * Extensions are conditionally registered based on feature flags:
 * - sandboxEnabled: Cloud sandbox workspace creation
 * - globalChatEnabled: Global Chat rail sections
 *
 * @example
 * ```tsx
  * await initClaxedo({
  *   authBaseUrl: window.location.origin,
 *   gatewayUrl: "http://127.0.0.1:3000",
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

  // `hostedComposition` answers whether this build has a hosted implementation
  // it may load. Only the desktop supplies the loader, and there Electron main
  // owns the account: HostedContributionSync follows the AccountPort and
  // registers the set only once it reports `signed`.
  const contributions = configureProductContributions({
    local: localContentSurfaces,
    register: registerContentSurface,
    unregister: unregisterContentSurface,
    loadHosted: config.loadHostedContributions,
    loadAgentPlugins: async () =>
      (await import("@/app/composition/agent-plugin-contribution-loader")).agentPluginContributions(),
    hostedComposition: () => config.loadHostedContributions !== undefined,
  })

  if (config.serviceContributionLoaders) {
    configureServiceContributions({
      local: localContentSurfaces,
      loaders: config.serviceContributionLoaders,
      register: registerContentSurface,
      unregister: unregisterContentSurface,
    })
  }

  // Starting the identity provider is not this function's job: a runtime
  // guard would not keep it out of the local bundle, since a non-executing
  // branch does not remove the module, and a dynamic import only turns it into
  // a lazy chunk the local build still ships.
  //
  // The hosted entry starts it instead (`app/entry/main.tsx`), where the
  // decision to have an identity provider is actually made; this function
  // keeps only the parts both products share.
  if (config.loadHostedContributions) contributions.expectHosted()

  contributions.expectAgentPlugins()
  void contributions.activateAgentPlugins().catch(() => {})
}

/**
 * Get the default Claxedo configuration from environment variables.
 */
export function getDefaultConfig(): ClaxedoConfig {
  const envString = (value: unknown) => (typeof value === "string" ? value : undefined)

  return {
    authBaseUrl: envString(import.meta.env.VITE_AUTH_BASE_URL) ?? window.location.origin,
    gatewayUrl: envString(import.meta.env.VITE_CLAXEDO_SERVER_URL) ?? "http://127.0.0.1:3000",
    cloudAutoSwitch: import.meta.env.VITE_CLOUD_AUTOSWITCH !== "false",

    // Feature flags - all default to false for standalone mode
    sandboxEnabled: import.meta.env.VITE_SANDBOX_ENABLED === "true",
    globalChatEnabled: import.meta.env.VITE_GLOBAL_CHAT_ENABLED === "true",
    ...productUiFlagConfigFromEnv(import.meta.env),
    claxedoServerUrl: envString(import.meta.env.VITE_CLAXEDO_SERVER_URL) ?? DEFAULT_LOCAL_CLAXEDO_SERVER_URL,
  }
}

// The authenticated-identity surface lives on `@claxedo/app/auth`, not here.
// Re-exporting it from the main entry made the auth vendor a static edge of every build
// that imports this module for `getDefaultConfig` — including the local one,
// which can never sign in. See `entry/auth.ts`.
export type { ClaxedoConfig as Config }

// This barrel is the eager boot graph of every product entry (web main.tsx,
// local.tsx, desktop shell.tsx), so it exports only what those entries and
// external consumers actually import. A re-export here rides the eager main
// chunk of every build — surfaces that open on demand (settings, routes,
// dialogs) must stay behind their lazy() boundaries in feature-ports instead.
export { usePlatform, PlatformProvider, type Platform } from "@/platform/runtime/platform-provider"
export { useServer } from "@/app/connection/server"
export { handleNotificationClick } from "@/platform/notifications/notification-click"
