import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { openExternal } from "@/lib/external-link"
import { Button } from "@/ui"
import { browserDictionary } from "../i18n"

export function ElsewherePage(props: { readonly url: string; readonly place: string }): JSX.Element {
  const t = useTranslator(browserDictionary)
  return (
    <div class="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-text-weak">
      <p class="max-w-sm">{t("browser.elsewhere.note", { place: props.place })}</p>
      <Button variant="neutral" size="small" onClick={() => openExternal(props.url)}>
        {t("browser.elsewhere.open")}
      </Button>
    </div>
  )
}
