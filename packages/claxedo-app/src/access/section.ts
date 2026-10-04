import type { SettingsSection } from "@/shell"
import { useTranslator } from "@/i18n"
import { accessDictionary } from "./i18n"
import { lazyView } from "@/lib/lazy-view"

export const organizationSettingsSection: SettingsSection = {
  id: "organization",
  title: () => useTranslator(accessDictionary)("access.org.title"),
  group: "account",
  order: 30,
  view: lazyView(() => import("./view/organization").then((module) => module.OrganizationSection)),
}
