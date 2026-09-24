import { createEffect, createSignal } from "solid-js"
import { t } from "../i18n"
import type { BrowserTab } from "../tab"
import { normalizeAddressBarInput, visibleUrl } from "../url"

export function AddressBar(props: { readonly tab: BrowserTab }) {
  const live = () => visibleUrl(props.tab.state().url)
  const [draft, setDraft] = createSignal(live())
  const [focused, setFocused] = createSignal(false)

  createEffect(() => {
    const url = live()
    if (!focused()) setDraft(url)
  })

  const commit = () => {
    const url = normalizeAddressBarInput(draft())
    if (!url) return
    setDraft(url)
    if (url !== props.tab.state().url) void props.tab.navigate(url)
  }

  const reset = (input: HTMLInputElement) => {
    setDraft(live())
    input.blur()
  }

  return (
    <div
      class="flex min-w-48 flex-1 basis-40 items-center rounded-md border bg-surface-base px-2 focus-within:border-border-strong-base focus-within:bg-background-base"
      classList={{
        "border-border-weak-base": props.tab.state().kind !== "picking",
        "border-border-active": props.tab.state().kind === "picking",
      }}
    >
      <input
        type="text"
        aria-label={t("browser.address")}
        placeholder={t("browser.address.placeholder")}
        value={draft()}
        spellcheck={false}
        autocomplete="off"
        class="h-7 min-w-0 flex-1 bg-transparent text-12-regular text-text-base outline-none placeholder:text-text-weak pointer-coarse:h-11"
        onInput={(event) => setDraft(event.currentTarget.value)}
        onFocus={(event) => {
          setFocused(true)
          event.currentTarget.select()
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            commit()
          } else if (event.key === "Escape") {
            reset(event.currentTarget)
          }
        }}
      />
    </div>
  )
}
