import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

export const SIDE_PANEL_BORDER_WIDTH = 1
export const SIDE_PANEL_MOTION_MS = 120
export const SIDE_PANEL_MOTION = `transform ${SIDE_PANEL_MOTION_MS}ms cubic-bezier(0.2, 0, 0, 1)`
export const SIDE_PANEL_INSET_MOTION = `margin-right ${SIDE_PANEL_MOTION_MS}ms cubic-bezier(0.2, 0, 0, 1)`

export function createSidePanelExposed(open: Accessor<boolean>): Accessor<boolean> {
  const [exposed, setExposed] = createSignal(open())
  let hideTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    clearTimeout(hideTimer)
    if (open()) {
      setExposed(true)
      return
    }
    hideTimer = setTimeout(() => setExposed(false), SIDE_PANEL_MOTION_MS + 20)
  })
  onCleanup(() => clearTimeout(hideTimer))
  return exposed
}
