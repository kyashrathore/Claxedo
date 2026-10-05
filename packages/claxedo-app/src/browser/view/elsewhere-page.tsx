import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { browserDictionary } from "../i18n"

export function ElsewherePage(props: { readonly url: string; readonly place: string | undefined }): JSX.Element {
  const t = useTranslator(browserDictionary)
  return (
    <div class="flex h-full w-full flex-col items-center justify-center gap-1 p-6 text-center text-sm text-text-weak">
      <p class="max-w-sm">{props.place ? t("browser.elsewhere.note", { place: props.place, url: props.url }) : t("browser.elsewhere.noteUnnamed", { url: props.url })}</p>
    </div>
  )
}
