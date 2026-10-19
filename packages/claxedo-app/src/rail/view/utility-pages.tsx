import { useTranslator } from "@/i18n"
import { MarketplacePage } from "@/marketplace"
import type { PageEntry } from "@/shell"
import { railDictionary } from "../i18n"

export const MARKETPLACE_PATH = "/marketplace"

export const marketplacePage: PageEntry = {
  id: "marketplace",
  path: MARKETPLACE_PATH,
  title: () => useTranslator(railDictionary)("rail.marketplace"),
  icon: "marketplace",
  sidebar: "main",
  tab: true,
  view: MarketplacePage,
}
