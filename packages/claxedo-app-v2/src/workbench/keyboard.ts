import type { KeyMap } from "./types"

export function matchKey(event: KeyboardEvent, spec: string): boolean {
  const parts = spec.toLowerCase().split("+").map((p) => p.trim())
  let needMod = false
  let needShift = false
  let needAlt = false
  let key = ""
  for (const part of parts) {
    if (part === "mod" || part === "ctrl" || part === "meta" || part === "cmd") needMod = true
    else if (part === "shift") needShift = true
    else if (part === "alt" || part === "option") needAlt = true
    else key = part
  }
  if (event.key.toLowerCase() !== key) return false
  if (needShift !== event.shiftKey) return false
  if (needAlt !== event.altKey) return false
  return needMod === (event.metaKey || event.ctrlKey)
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

export function eventTargetIsEditable(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false
  const tag = target.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  return target instanceof HTMLElement && target.isContentEditable
}

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
