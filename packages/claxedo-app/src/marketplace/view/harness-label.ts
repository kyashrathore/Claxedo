import { useTranslator } from "@/i18n"
import { harnessDisplayLabel } from "@/lib/harness-catalog"
import type { PluginHarness } from "@/server"
import { marketplaceDictionary } from "../i18n"

export function useHarnessLabel(): (harness: PluginHarness) => string {
  const t = useTranslator(marketplaceDictionary)
  return (harness) => (harness === "acp" ? t("marketplace.harness.acp") : harnessDisplayLabel(harness))
}
