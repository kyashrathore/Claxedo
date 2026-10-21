import { useI18n } from "@/i18n"
import { lazyView } from "@/lib/lazy-view"
import type { SettingsSection } from "@/shell"
import type { AccountsKey } from "./i18n"

export { harnesses } from "./model"
export { useAccounts } from "./store"
export { useSandboxKeys, type SandboxKeysLoad, type SandboxKeysStore, type SandboxListing } from "./sandbox-store"
export { createHarnessProviders, type HarnessProviders } from "./harness-providers-state"

export const loadOnboardingAccountViews = () => Promise.all([import("./view/sandbox-key-form"), import("./view/harness-accounts"), import("./view/harness-providers")])
export const InlineSandboxKeyForm = lazyView(() => import("./view/sandbox-key-form").then((module) => module.InlineSandboxKeyForm))
export const AgentHarnessAccounts = lazyView(() => import("./view/harness-accounts").then((module) => module.AgentHarnessAccounts))
export const HarnessProvidersSection = lazyView(() => import("./view/harness-providers").then((module) => module.HarnessProvidersSection))

export const loadAccountsTranslations = () => import("./i18n").then((module) => module.accountsDictionary)

const title = (key: AccountsKey) => () => useI18n().t(key)

export const modelsSettingsSection: SettingsSection = {
  id: "models",
  title: title("settings.models.title"),
  translations: loadAccountsTranslations,
  group: "account",
  order: 35,
  view: lazyView(() => import("./view/models-section").then((module) => module.ModelsSection)),
}

export const sandboxSettingsSection: SettingsSection = {
  id: "sandbox",
  title: title("settings.sandbox.title"),
  translations: loadAccountsTranslations,
  group: "account",
  order: 47,
  view: lazyView(() => import("./view/sandbox-section").then((module) => module.SandboxSection)),
}
