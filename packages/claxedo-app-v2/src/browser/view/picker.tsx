import { Show, createEffect, onCleanup } from "solid-js"
import { t } from "../i18n"
import type { BrowserTab } from "../tab"

export function PickerShield(props: { readonly tab: BrowserTab }) {
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
        <span class="rounded-md border border-border-weak-base bg-surface-base px-2 py-1 text-12-regular text-text-base">
          {t("browser.picking.hint")}
        </span>
      </div>
    </Show>
  )
}
