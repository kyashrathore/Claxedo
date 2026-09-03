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

  /** Enable Better Auth + claxedo server (default: false) */
  authEnabled?: boolean
  /** Allow cloud sandbox workspace creation (default: false) */
  sandboxEnabled?: boolean
  /** Show Global Chat sections in the rail (default: false) */
  globalChatEnabled?: boolean
  /** Direct Daytona API key for no-auth sandbox mode */
  daytonaApiKey?: string
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
 * - authEnabled: Better Auth + claxedo server
 * - sandboxEnabled: Cloud sandbox workspace creation
 * - globalChatEnabled: Global Chat rail sections
 * - daytonaApiKey: Direct Daytona API key for no-auth sandbox mode
 *
 * @example
 * ```tsx
  * await initClaxedo({
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

  // `hostedComposition` answers whether this build has a hosted implementation
  // it may load. Browser hosted builds activate immediately (`authEnabled`);
  // desktop releases supply the loader but leave auth disabled because Electron
  // main owns the account. In that composition HostedContributionSync follows
  // the Electron AccountPort and activates only after it reports `signed`.
  const contributions = configureProductContributions({
    local: localContentSurfaces,
    register: registerContentSurface,
    unregister: unregisterContentSurface,
    loadHosted: config.loadHostedContributions,
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
  if (config.loadHostedContributions) contributions.expectHosted()

  if (config.authEnabled && config.loadHostedContributions) {
    // Hosted composition: WorkGraph and Documents arrive as one lazily
    // imported contribution set rather than as static imports of this entry.
    //
    // `expectHosted()` runs synchronously and `activateHosted` resolves later,
    // and the split matters: restored-state pruning must know that WorkGraph
    // tabs are legal in this build BEFORE the dynamic import lands, or a hosted
    // reload would drop every restored WorkGraph tab in the gap.
    void contributions.activateHosted().catch(() => {})
  }
}

/**
 * Get the default Claxedo configuration from environment variables.
 */
export function getDefaultConfig(): ClaxedoConfig {
  const envString = (value: unknown) => (typeof value === "string" ? value : undefined)

  return {
    authBaseUrl: envString(import.meta.env.VITE_AUTH_BASE_URL) ?? window.location.origin,
    gatewayUrl: envString(import.meta.env.VITE_OPENCODE_BACKEND_URL) ?? "http://127.0.0.1:3000",
    cloudAutoSwitch: import.meta.env.VITE_CLOUD_AUTOSWITCH !== "false",

    // Feature flags - all default to false for standalone mode
    authEnabled: import.meta.env.VITE_AUTH_ENABLED === "true",
    sandboxEnabled: import.meta.env.VITE_SANDBOX_ENABLED === "true",
    globalChatEnabled: import.meta.env.VITE_GLOBAL_CHAT_ENABLED === "true",
    ...productUiFlagConfigFromEnv(import.meta.env),
    daytonaApiKey: envString(import.meta.env.VITE_DAYTONA_API_KEY),
    claxedoServerUrl: envString(import.meta.env.VITE_CLAXEDO_SERVER_URL) ?? DEFAULT_LOCAL_CLAXEDO_SERVER_URL,
  }
}

// The authenticated-identity surface lives on `@claxedo/app/auth`, not here.
// Re-exporting it from the main entry made the auth vendor a static edge of every build
// that imports this module for `getDefaultConfig` — including the local one,
// which can never sign in. See `entry/auth.ts`.
export type { ClaxedoConfig as Config }

// This barrel is the eager boot graph of every product entry (web main.tsx,
// local.tsx, desktop shell.tsx), so it exports ONLY what those entries and
// external consumers actually import. A re-export here rides the eager main
// chunk of every build — surfaces that open on demand (settings, routes,
// dialogs) must stay behind their lazy() boundaries in feature-ports instead.
export { usePlatform, PlatformProvider, type Platform } from "@/platform/runtime/platform-provider"
export { useServer } from "@/app/connection/server"
export { handleNotificationClick } from "@/platform/notifications/notification-click"
