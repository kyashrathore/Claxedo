import { lazyView } from "@/lib/lazy-view"
import type { SettingsSection } from "@/shell"
import { useAccountsText } from "./i18n"

export { harnesses } from "./model"
export { useAccounts } from "./store"
export { useSandboxKeys, type SandboxKeysLoad, type SandboxKeysStore, type SandboxListing } from "./sandbox-store"
export { InlineSandboxKeyForm } from "./view/sandbox-key-form"
export { AgentHarnessAccounts } from "./view/harness-accounts"
export { createHarnessProviders, HarnessProvidersSection, type HarnessProviders } from "./view/harness-providers"

export const modelsSettingsSection: SettingsSection = {
  id: "models",
  title: () => useAccountsText()("settings.models.title"),
  group: "account",
  order: 35,
  view: lazyView(() => import("./view/models-section").then((module) => module.ModelsSection)),
}

export const sandboxSettingsSection: SettingsSection = {
  id: "sandbox",
  title: () => useAccountsText()("settings.sandbox.title"),
  group: "account",
  order: 47,
  view: lazyView(() => import("./view/sandbox-section").then((module) => module.SandboxSection)),
}
