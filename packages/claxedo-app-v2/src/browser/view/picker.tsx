import { Show, createEffect, onCleanup, type JSX } from "solid-js"
import type { BrowserTab } from "../tab"

export function PickerShield(props: { readonly tab: BrowserTab }): JSX.Element {
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
      <div
        class="absolute inset-0"
        style={{ "pointer-events": "none", cursor: "crosshair" }}
        data-testid="browser-pane-inspect-shield"
        aria-hidden="true"
      />
    </Show>
  )
}
