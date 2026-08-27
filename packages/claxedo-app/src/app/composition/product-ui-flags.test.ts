import { describe, expect, test } from "bun:test"
import { productUiFlagConfigFromEnv, resolveProductUiFlags } from "./product-ui-flags"

describe("product UI flags", () => {
  test("defaults every gated entry point off", () => {
    expect(resolveProductUiFlags()).toEqual({
      documentNavigation: false,
      workGraphNavigation: false,
      accountSignIn: false,
      settingsConnections: false,
      settingsSandboxProviders: false,
    })
  })

  test("enables only explicitly selected entry points", () => {
    expect(resolveProductUiFlags({
      documentNavigationEnabled: true,
      settingsConnectionsEnabled: true,
    })).toEqual({
      documentNavigation: true,
      workGraphNavigation: false,
      accountSignIn: false,
      settingsConnections: true,
      settingsSandboxProviders: false,
    })
  })

  test("maps build variables with strict default-off semantics", () => {
    expect(productUiFlagConfigFromEnv({})).toEqual({
      documentNavigationEnabled: false,
      workGraphNavigationEnabled: false,
      accountSignInEnabled: false,
      settingsConnectionsEnabled: false,
      settingsSandboxProvidersEnabled: false,
    })

    const cases = [
      ["VITE_CLAXEDO_DOCUMENT_NAVIGATION_ENABLED", "documentNavigationEnabled"],
      ["VITE_CLAXEDO_WORKGRAPH_NAVIGATION_ENABLED", "workGraphNavigationEnabled"],
      ["VITE_CLAXEDO_ACCOUNT_SIGN_IN_ENABLED", "accountSignInEnabled"],
      ["VITE_CLAXEDO_SETTINGS_CONNECTIONS_ENABLED", "settingsConnectionsEnabled"],
      ["VITE_CLAXEDO_SETTINGS_SANDBOX_PROVIDERS_ENABLED", "settingsSandboxProvidersEnabled"],
    ] as const

    for (const [environmentName, configName] of cases) {
      const config = productUiFlagConfigFromEnv({ [environmentName]: "true" })
      expect(config[configName]).toBe(true)
      expect(Object.values(config).filter(Boolean)).toHaveLength(1)
    }

    expect(productUiFlagConfigFromEnv({
      VITE_CLAXEDO_DOCUMENT_NAVIGATION_ENABLED: true,
      VITE_CLAXEDO_WORKGRAPH_NAVIGATION_ENABLED: "false",
      VITE_CLAXEDO_ACCOUNT_SIGN_IN_ENABLED: "1",
    })).toEqual({
      documentNavigationEnabled: false,
      workGraphNavigationEnabled: false,
      accountSignInEnabled: false,
      settingsConnectionsEnabled: false,
      settingsSandboxProvidersEnabled: false,
    })
  })
})
