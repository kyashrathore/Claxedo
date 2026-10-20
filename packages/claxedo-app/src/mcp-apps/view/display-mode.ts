import { createSignal, onCleanup, type Accessor } from "solid-js"
import type { DisplayMode } from "../model"

export type AppDisplay = {
  readonly mode: Accessor<DisplayMode>
  readonly request: (mode: DisplayMode | undefined) => DisplayMode
}

function showInTopLayer(element: HTMLElement, fullscreen: boolean): void {
  const open = element.matches(":popover-open")
  if (fullscreen && !open) element.showPopover()
  if (!fullscreen && open) element.hidePopover()
}

export function createAppDisplay(element: () => HTMLElement | undefined): AppDisplay {
  const [mode, setMode] = createSignal<DisplayMode>("inline")
  const request = (next: DisplayMode | undefined): DisplayMode => {
    const target = element()
    if (!next || !target) return mode()
    try {
      showInTopLayer(target, next === "fullscreen")
      setMode(next)
    } catch (error) {
      console.warn("mcp-apps: the app could not change its display mode", { mode: next, error })
    }
    return mode()
  }
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || mode() !== "fullscreen") return
    event.preventDefault()
    request("inline")
  }
  document.addEventListener("keydown", onKeydown)
  onCleanup(() => document.removeEventListener("keydown", onKeydown))
  return { mode, request }
}
