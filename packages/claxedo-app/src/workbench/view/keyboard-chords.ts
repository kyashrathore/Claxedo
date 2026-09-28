import { createMemo, onCleanup, onMount } from "solid-js"
import { eventTargetIsEditable, matchKey, resolveKeyMap } from "../keyboard"
import type { WorkbenchStore } from "../store"
import type { KeyMap } from "../types"
import { paneInDirection, type FocusDirection } from "./focus-direction"

const directions: readonly [keyof KeyMap, FocusDirection][] = [
  ["focusLeft", "left"],
  ["focusRight", "right"],
  ["focusUp", "up"],
  ["focusDown", "down"],
]

type ChordInput = {
  wb: WorkbenchStore
  keyMap?: Partial<KeyMap>
  onCloseFocusedPane?: (paneId: string, contentId: string | null) => void
}

function closeFocused(input: ChordInput, keyMap: KeyMap, event: KeyboardEvent): void {
  const state = input.wb.layout()
  if (eventTargetIsEditable(event.target) && keyMap.closePane !== "mod+w") return
  event.preventDefault()
  const paneId = state.focusedPaneId
  if (!paneId) return
  const contentId = state.panes.find((pane) => pane.id === paneId)?.contentId ?? null
  if (input.onCloseFocusedPane) input.onCloseFocusedPane(paneId, contentId)
  else input.wb.split.close(paneId, { destroyContent: false })
}

function splitFocused(wb: WorkbenchStore, event: KeyboardEvent, edge: "right" | "bottom"): void {
  event.preventDefault()
  const focused = wb.layout().focusedPaneId
  if (!focused) return
  const hidden = wb.selectors.mruHiddenContent()
  if (hidden) wb.split.split(focused, edge, hidden)
}

function focusInDirection(wb: WorkbenchStore, keyMap: KeyMap, event: KeyboardEvent): void {
  for (const [key, direction] of directions) {
    if (!matchKey(event, keyMap[key])) continue
    event.preventDefault()
    const target = paneInDirection(wb.layout(), direction)
    if (target) wb.split.focus(target)
    return
  }
}

function handleChord(input: ChordInput, keyMap: KeyMap, event: KeyboardEvent): void {
  if (matchKey(event, keyMap.closePane)) return closeFocused(input, keyMap, event)
  if (eventTargetIsEditable(event.target)) return
  if (matchKey(event, keyMap.splitRight)) return splitFocused(input.wb, event, "right")
  if (matchKey(event, keyMap.splitDown)) return splitFocused(input.wb, event, "bottom")
  focusInDirection(input.wb, keyMap, event)
}

export function useWorkbenchChords(input: ChordInput) {
  const keyMap = createMemo(() => resolveKeyMap(input.keyMap))
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    if (event.key === "Escape" && input.wb.drag.active()) return input.wb.drag.cancel()
    handleChord(input, keyMap(), event)
  }
  onMount(() => {
    window.addEventListener("keydown", onKeyDown)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown))
  })
}
