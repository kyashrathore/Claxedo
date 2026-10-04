import { lazyView } from "@/lib/lazy-view"
import type { SettingsSection } from "@/shell"
import { useAccountsText } from "./i18n"

export { harnesses } from "./model"
export { useAccounts } from "./store"
export { AgentHarnessAccounts } from "./view/harness-accounts"
export { createHarnessProviders, HarnessProvidersSection, type HarnessProviders } from "./view/harness-providers"

export const modelsSettingsSection: SettingsSection = {
  id: "models",
  title: () => useAccountsText()("settings.models.title"),
  group: "account",
  order: 35,
  view: lazyView(() => import("./view/models-section").then((module) => module.ModelsSection)),
}
