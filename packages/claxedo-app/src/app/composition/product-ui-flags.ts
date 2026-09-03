/**
 * Build-configured product UI switches.
 *
 * These flags control entry points only; they do not change the underlying
 * authorization or surface contracts. Every switch is strict opt-in so an
 * omitted config value remains off in embedders as well as default builds.
 */
export type ProductUiFlagConfig = {
  /** Show Documents navigation entry points (default: false). */
  documentNavigationEnabled?: boolean
  /** Show the unsigned account sign-in affordance (default: false). */
  accountSignInEnabled?: boolean
  /** Show the Connections settings section (default: false). */
  settingsConnectionsEnabled?: boolean
  /** Show the Sandbox Providers settings section (default: false). */
  settingsSandboxProvidersEnabled?: boolean
}

export type ProductUiFlags = {
  documentNavigation: boolean
  accountSignIn: boolean
  settingsConnections: boolean
  settingsSandboxProviders: boolean
}

export function resolveProductUiFlags(config?: ProductUiFlagConfig): ProductUiFlags {
  return {
    documentNavigation: config?.documentNavigationEnabled === true,
    accountSignIn: config?.accountSignInEnabled === true,
    settingsConnections: config?.settingsConnectionsEnabled === true,
    settingsSandboxProviders: config?.settingsSandboxProvidersEnabled === true,
  }
}

export function productUiFlagConfigFromEnv(env: Readonly<Record<string, unknown>>): Required<ProductUiFlagConfig> {
  return {
    documentNavigationEnabled: env.VITE_CLAXEDO_DOCUMENT_NAVIGATION_ENABLED === "true",
    accountSignInEnabled: env.VITE_CLAXEDO_ACCOUNT_SIGN_IN_ENABLED === "true",
    settingsConnectionsEnabled: env.VITE_CLAXEDO_SETTINGS_CONNECTIONS_ENABLED === "true",
    settingsSandboxProvidersEnabled: env.VITE_CLAXEDO_SETTINGS_SANDBOX_PROVIDERS_ENABLED === "true",
  }
}
