import { Show, createEffect, onCleanup, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { dictionary } from "../i18n"
import type { BrowserTab } from "../tab"

export function PickerShield(props: { readonly tab: BrowserTab }): JSX.Element {
  const t = useTranslator(dictionary)
  const picking = () => props.tab.state().kind === "picking"

  createEffect(() => {
    if (!picking()) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.tab.setPicking(false)
    }
    window.addEventListener("keydown", onKeyDown)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown))
  })

  return (
    <Show when={picking()}>
      <div class="pointer-events-none absolute inset-0 cursor-crosshair" aria-hidden="true" />
      <div role="status" class="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-2">
        <span class="rounded-md border border-border-muted bg-background-layer-01 px-2 py-1 text-sm text-text-base">{t("browser.picking.hint")}</span>
      </div>
    </Show>
  )
}
