import { createMemo, onCleanup, onMount } from "solid-js"
import { eventTargetIsEditable, matchKey, resolveKeyMap, type createSurfaceKeyRouter } from "../keyboard"
import type { WorkbenchStore } from "../store"
import type { KeyMap } from "../types"
import { paneInDirection, type FocusDirection } from "./focus-direction"

type SurfaceKeys = ReturnType<typeof createSurfaceKeyRouter>

const directions: readonly [keyof KeyMap, FocusDirection][] = [
  ["focusLeft", "left"],
  ["focusRight", "right"],
  ["focusUp", "up"],
  ["focusDown", "down"],
]

export function useWorkbenchChords(input: {
  wb: WorkbenchStore
  keyMap?: Partial<KeyMap>
  surfaceKeys: SurfaceKeys
  onCloseFocusedPane?: (paneId: string, contentId: string | null) => void
}) {
  const keyMap = createMemo(() => resolveKeyMap(input.keyMap))

  const closeFocused = (event: KeyboardEvent) => {
    const state = input.wb.layout()
    if (eventTargetIsEditable(event.target) && keyMap().closePane !== "mod+w") return
    event.preventDefault()
    const paneId = state.focusedPaneId
    if (!paneId) return
    const contentId = state.panes.find((pane) => pane.id === paneId)?.contentId ?? null
    if (input.onCloseFocusedPane) input.onCloseFocusedPane(paneId, contentId)
    else input.wb.split.close(paneId, { destroyContent: false })
  }

  const splitFocused = (event: KeyboardEvent, edge: "right" | "bottom") => {
    event.preventDefault()
    const state = input.wb.layout()
    if (!state.focusedPaneId) return
    const hidden = input.wb.selectors.mruHiddenContent()
    if (hidden) input.wb.split.split(state.focusedPaneId, edge, hidden)
  }

  const handleChord = (event: KeyboardEvent) => {
    const km = keyMap()
    if (matchKey(event, km.closePane)) return closeFocused(event)
    if (eventTargetIsEditable(event.target)) return
    if (matchKey(event, km.splitRight)) return splitFocused(event, "right")
    if (matchKey(event, km.splitDown)) return splitFocused(event, "bottom")
    for (const [key, direction] of directions) {
      if (!matchKey(event, km[key])) continue
      event.preventDefault()
      const target = paneInDirection(input.wb.layout(), direction)
      if (target) input.wb.split.focus(target)
      return
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    if (event.key === "Escape" && input.wb.drag.active()) return input.wb.drag.cancel()
    handleChord(event)
    if (!event.defaultPrevented) input.surfaceKeys.forward(event)
  }

  onMount(() => {
    window.addEventListener("keydown", onKeyDown)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown))
  })
}
