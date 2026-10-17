import { useI18n } from "@/i18n"
import { harnessesServedBy } from "../model"

export function useServedBy(): (providerIds: readonly string[]) => string {
  const i18n = useI18n()
  return (providerIds) => new Intl.ListFormat(i18n.intlTag(), { style: "long", type: "conjunction" }).format(harnessesServedBy(providerIds))
}
