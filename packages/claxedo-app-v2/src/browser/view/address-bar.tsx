import { createSignal, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { TextInput } from "@/ui"
import { dictionary } from "../i18n"
import type { BrowserTab } from "../tab"
import { normalizeAddressBarInput, visibleUrl } from "../url"

export function AddressBar(props: { readonly tab: BrowserTab }): JSX.Element {
  const t = useTranslator(dictionary)
  const [draft, setDraft] = createSignal<string>()
  const shown = () => draft() ?? visibleUrl(props.tab.state().url)

  const commit = () => {
    const url = normalizeAddressBarInput(shown())
    if (!url) return
    setDraft(url)
    if (url !== props.tab.state().url) void props.tab.navigate(url)
  }

  return (
    <div class="min-w-48 flex-1 basis-40" data-picking={props.tab.state().kind === "picking" ? "" : undefined}>
      <TextInput
        type="text"
        aria-label={t("browser.address")}
        placeholder={t("browser.address.placeholder")}
        value={shown()}
        spellcheck={false}
        autocomplete="off"
        onInput={(event) => setDraft(event.currentTarget.value)}
        onFocus={(event) => {
          setDraft(visibleUrl(props.tab.state().url))
          event.currentTarget.select()
        }}
        onBlur={() => setDraft(undefined)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            commit()
            event.currentTarget.blur()
          } else if (event.key === "Escape") {
            setDraft(undefined)
            event.currentTarget.blur()
          }
        }}
      />
    </div>
  )
}
