/**
 * App Extensions Factory
 *
 * Provides app-level extensions for cloud functionality including:
 * - Auth providers
 * - Protected route guards
 * - Cloud-specific routes (login, etc.)
 * - Cloud-specific i18n strings
 * - Account settings section with logout
 */

import { lazy, Show, Suspense, type ParentComponent, type ParentProps } from "solid-js"
import type { AppExtensions } from "@opencode-ai/app-shared"
import type { ClaxedoConfig } from "../index"
import { cloudStrings } from "../i18n/cloud-strings"
import { initializeClerk, useAuth } from "../utils/auth-client"
import { AccountSettingsSection } from "../components/settings-account-section"

import { createCloudAutoSwitchProvider } from "../components/cloud-auto-switch"
import { ClaxedoLayout } from "../claxedo-ui/ClaxedoLayout"

// Lazy load the login page for code splitting
const LoginPage = lazy(() => import("../pages/login"))

/**
 * Auth Provider wrapper component.
 * Provides authentication context to the app.
 */
function createAuthProvider(_config: ClaxedoConfig): ParentComponent {
  return (props: ParentProps) => {
    // Auth state is managed by the Clerk singleton.
    // This provider can be extended to add context if needed.
    return <>{props.children}</>
  }
}

/**
 * Cloud Server Provider wrapper component.
 * Provides cloud server context for session management.
 */
function createCloudServerProvider(_config: ClaxedoConfig): ParentComponent {
  return (props: ParentProps) => {
    // Cloud server state management can be added here.
    // For now, the existing ServerProvider handles this.
    return <>{props.children}</>
  }
}

/**
 * Auth Guard component.
 * Protects routes by requiring authentication in cloud mode.
 */
function createRequireAuth(_config: ClaxedoConfig): ParentComponent {
  return (props: ParentProps) => {
    const auth = useAuth()

    // In cloud mode, check authentication
    const isCloudMode = () => true // Always cloud mode when this package is loaded

    // Show loading state while checking auth, or if authenticated
    const isAuthenticated = () => auth.loading() || auth.isSignedIn() || !isCloudMode()

    // Redirect to login if not authenticated (after loading completes)
    if (!auth.loading() && !auth.isSignedIn() && isCloudMode()) {
      if (typeof window !== "undefined" && window.location.pathname !== "/login") {
        window.location.href = "/login"
        return null
      }
    }

    return (
      <Show
        when={isAuthenticated()}
        fallback={<div class="size-full flex items-center justify-center">Loading...</div>}
      >
        {props.children}
      </Show>
    )
  }
}

/**
 * Loading fallback component
 */
const Loading = () => <div class="size-full" />

/**
 * Create app extensions for Claxedo.
 *
 * Extensions are conditionally registered based on feature flags:
 * - authEnabled: Clerk auth + claxedo server (providers, authGuard, routes, onInit)
 * - sandboxEnabled: Cloud workspace creation (Compute tab in settings)
 *
 * @param config - Claxedo configuration
 * @returns AppExtensions object to register with the extension system
 */
export function appExtensions(config: ClaxedoConfig): AppExtensions {
  const extensions: AppExtensions = {
    /**
     * Cloud-specific i18n strings merged into core dictionaries.
     * Always included for consistent UX.
     */
    strings: cloudStrings,

    /**
     * Custom layout component with Rail + Tab UI.
     * Replaces the default app shell with Claxedo's layout.
     * Always included - this is the core Claxedo UX.
     */
    layoutComponent: ClaxedoLayout,

    // Terminal tabs render via GroupContentRenderer + MultiPaneTab/PaneTerminal.
    // Keep directoryProviders empty to avoid route-scoped terminal side effects.
    directoryProviders: [],

    /**
     * Settings sections - start empty, populated based on flags.
     */
    settingsSections: [],
  }

  // ─────────────────────────────────────────────
  // AUTH FEATURES (Clerk + claxedo server)
  // ─────────────────────────────────────────────
  if (config.authEnabled) {
    extensions.providers = [createAuthProvider(config), createCloudServerProvider(config)]
    extensions.authGuard = createRequireAuth(config)
    extensions.authenticatedProviders = [createCloudAutoSwitchProvider()]
    extensions.routes = [
      {
        path: "/login",
        component: () => (
          <Suspense fallback={<Loading />}>
            <LoginPage />
          </Suspense>
        ),
      },
    ]
    extensions.onInit = async () => {
      try {
        await initializeClerk()
      } catch {
      }
    }
    extensions.settingsSections = [AccountSettingsSection]
    extensions.hideShareButton = true
    extensions.serverSelectorMode = "status-only"
  } else {
    // No auth mode - show full server selector
    extensions.serverSelectorMode = "full"
  }

  // Sandbox settings ("Compute" tab) are rendered directly by dialog-settings.tsx
  // when sandboxEnabled is true — no settingsSections registration needed.

  return extensions
}
