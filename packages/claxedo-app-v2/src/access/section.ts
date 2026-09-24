import type { SettingsSection } from "@/shell"
import { useTranslator } from "@/i18n"
import { dictionary } from "./i18n"
import { OrganizationSection } from "./view/organization"

export const organizationSettingsSection: SettingsSection = {
  id: "organization",
  title: () => useTranslator(dictionary)("access.org.title"),
  group: "account",
  order: 30,
  view: OrganizationSection,
}
