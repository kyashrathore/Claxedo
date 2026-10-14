import type { SettingsSection } from "@/shell"
import { useTranslator } from "@/i18n"
import { useServer } from "@/server"
import { usageDictionary, type UsageKey } from "./i18n"
import { lazyView } from "@/lib/lazy-view"

export type { QuotaWindow } from "./model"
export { useWindowName } from "./view/quota-windows"

export const USAGE_LIMITS_SECTION = "usage-limits"

const usageSection = (id: string, title: UsageKey, order: number, view: SettingsSection["view"]): SettingsSection => ({
  id,
  title: () => useTranslator(usageDictionary)(title),
  group: "account",
  order,
  view,
})

const summarySections = () => import("./view/summary-sections")

export const usageLimitsSettingsSection = usageSection(USAGE_LIMITS_SECTION, "usage.limits.title", 20, lazyView(() => summarySections().then((module) => module.UsageLimitsSection)))

export const aiUsageSettingsSection = usageSection("ai-usage", "usage.ai.title", 21, lazyView(() => summarySections().then((module) => module.AiUsageSection)))

export const sandboxUsageSettingsSection: SettingsSection = {
  ...usageSection("sandbox-usage", "usage.sandbox.title", 22, lazyView(() => import("./view/sandbox-usage-section").then((module) => module.SandboxUsageSection))),
  available: () => useServer().capabilities()?.features.cloud === true,
}
