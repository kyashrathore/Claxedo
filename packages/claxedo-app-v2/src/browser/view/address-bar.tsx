import { createEffect, createSignal, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { ClaxedoIcon as Icon } from "@/ui"
import { dictionary } from "../i18n"
import type { BrowserTab } from "../tab"
import { normalizeAddressBarInput, visibleUrl } from "../url"

const BLUR_SETTLE_MS = 120

export function AddressBar(props: { readonly tab: BrowserTab }): JSX.Element {
  const t = useTranslator(dictionary)
  const [draft, setDraft] = createSignal(visibleUrl(props.tab.state().url))
  const [focused, setFocused] = createSignal(false)
  const inspecting = () => props.tab.state().kind === "picking"
  createEffect(() => {
    const live = props.tab.state().url
    if (!focused()) setDraft(visibleUrl(live))
  })
  const commit = (value: string) => {
    const url = normalizeAddressBarInput(value.trim())
    if (!url) return
    setDraft(url)
    if (props.tab.bridge && url !== props.tab.state().url) void props.tab.navigate(url)
    setFocused(false)
  }
  return (
    <div class="relative flex min-w-0 flex-1 items-center" data-testid="browser-pane-address-bar-host">
      <div
        classList={{
          "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-surface-base px-2 transition-colors": true,
          "border-border-weak-base focus-within:border-border-strong-base focus-within:bg-background-base":
            !inspecting(),
          "border-border-active bg-surface-base-interactive-active": inspecting(),
        }}
      >
        <Icon
          name="magnifying-glass"
          size="small"
          class="shrink-0"
          classList={{
            "text-text-weak": !focused() && !inspecting(),
            "text-text-base": focused() || inspecting(),
          }}
        />
        <input
          type="text"
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onFocus={(event) => {
            setFocused(true)
            event.currentTarget.select()
          }}
          onBlur={() => setTimeout(() => setFocused(false), BLUR_SETTLE_MS)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              commit(draft())
            } else if (event.key === "Escape") {
              setFocused(false)
              setDraft(visibleUrl(props.tab.state().url))
              event.currentTarget.blur()
            }
          }}
          placeholder={t("browser.address.placeholder")}
          spellcheck={false}
          readOnly={!props.tab.bridge}
          class="min-w-0 flex-1 bg-transparent text-12-regular text-text-base placeholder:text-text-weak focus:outline-none"
          data-testid="browser-pane-address-bar"
        />
      </div>
    </div>
  )
}
