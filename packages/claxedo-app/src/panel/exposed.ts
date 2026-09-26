import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { PANEL_CLOSE_GRACE_MS } from "./width"

export function createExposed(open: Accessor<boolean>): Accessor<boolean> {
  const [exposed, setExposed] = createSignal(open())
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    clearTimeout(hideTimer)
    if (open()) {
      setExposed(true)
      return
    }
    hideTimer = setTimeout(() => setExposed(false), PANEL_CLOSE_GRACE_MS)
  })
  onCleanup(() => clearTimeout(hideTimer))
  return exposed
}
