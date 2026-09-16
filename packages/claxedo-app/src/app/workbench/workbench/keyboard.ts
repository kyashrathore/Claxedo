import type { KeyMap } from "./types"

/**
 * Match a keyboard event against a key spec like "mod+\\", "mod+shift+\\", "mod+alt+ArrowLeft".
 * "mod" maps to metaKey on Mac and ctrlKey elsewhere; we accept either to keep tests platform-agnostic.
 */
export function matchKey(event: KeyboardEvent, spec: string): boolean {
  const parts = spec.toLowerCase().split("+").map((p) => p.trim())
  let needMod = false
  let needShift = false
  let needAlt = false
  let key = ""
  for (const part of parts) {
    if (part === "mod") needMod = true
    else if (part === "shift") needShift = true
    else if (part === "alt" || part === "option") needAlt = true
    else if (part === "ctrl") needMod = true
    else if (part === "meta" || part === "cmd") needMod = true
    else key = part
  }
  const eventKey = event.key.toLowerCase()
  if (eventKey !== key) return false
  if (needShift !== event.shiftKey) return false
  if (needAlt !== event.altKey) return false
  if (needMod !== (event.metaKey || event.ctrlKey)) return false
  return true
}

export function resolveKeyMap(partial?: Partial<KeyMap>): KeyMap {
  return {
    closePane: partial?.closePane ?? "mod+w",
    focusLeft: partial?.focusLeft ?? "mod+alt+ArrowLeft",
    focusRight: partial?.focusRight ?? "mod+alt+ArrowRight",
    focusUp: partial?.focusUp ?? "mod+alt+ArrowUp",
    focusDown: partial?.focusDown ?? "mod+alt+ArrowDown",
    splitRight: partial?.splitRight ?? "mod+\\",
    splitDown: partial?.splitDown ?? "mod+shift+\\",
  }
}

/** Skip keyboard handling when the user is typing in a control. */
export function eventTargetIsEditable(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false
  const tag = target.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  if (target instanceof HTMLElement && target.isContentEditable) return true
  return false
}

/**
 * A key pressed with no element focused reaches `document`, where every mounted
 * surface would hear it — including the retained hidden tabs and the other half
 * of a split. The workbench holds the one listener and forwards to the shown
 * surface of the focused pane; surfaces subscribe through `PaneCtx.onKeyDown`.
 */
export type SurfaceKeySlot = {
  paneId: () => string | null
  visible: () => boolean
  keydown: Set<(event: KeyboardEvent) => void>
}

export function createSurfaceKeyRouter(focusedPaneId: () => string | null) {
  const slots = new Map<string, SurfaceKeySlot>()
  return {
    add(contentId: string, slot: SurfaceKeySlot) {
      slots.set(contentId, slot)
      return () => slots.delete(contentId)
    },
    subscribe(slot: SurfaceKeySlot, handler: (event: KeyboardEvent) => void) {
      slot.keydown.add(handler)
      return () => slot.keydown.delete(handler)
    },
    forward(event: KeyboardEvent) {
      const focused = focusedPaneId()
      if (!focused) return
      for (const slot of slots.values()) {
        if (slot.paneId() !== focused || !slot.visible()) continue
        for (const handler of slot.keydown) handler(event)
      }
    },
  }
}
