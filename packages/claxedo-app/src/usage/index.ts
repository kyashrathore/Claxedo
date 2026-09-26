import type { SettingsSection } from "@/shell"
import { useTranslator } from "@/i18n"
import { usageDictionary } from "./i18n"
import { UsageSection } from "./view/usage-section"

export type { QuotaAccount, QuotaWindow } from "./model"
export { QuotaWindowMeter, useWindowName } from "./view/quota-windows"

export const usageSettingsSection: SettingsSection = {
  id: "usage",
  title: () => useTranslator(usageDictionary)("usage.title"),
  group: "account",
  order: 20,
  view: UsageSection,
}
