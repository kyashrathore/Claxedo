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
  if (needShift !== !!event.shiftKey) return false
  if (needAlt !== !!event.altKey) return false
  if (needMod !== (!!event.metaKey || !!event.ctrlKey)) return false
  return true
}

export function resolveKeyMap(partial?: Partial<KeyMap>): KeyMap {
  return {
    splitHorizontal: partial?.splitHorizontal ?? "mod+\\",
    splitVertical: partial?.splitVertical ?? "mod+shift+\\",
    closePane: partial?.closePane ?? "mod+w",
    focusLeft: partial?.focusLeft ?? "mod+alt+ArrowLeft",
    focusRight: partial?.focusRight ?? "mod+alt+ArrowRight",
    focusUp: partial?.focusUp ?? "mod+alt+ArrowUp",
    focusDown: partial?.focusDown ?? "mod+alt+ArrowDown",
  }
}

/** Skip keyboard handling when the user is typing in a control. */
export function eventTargetIsEditable(target: EventTarget | null): boolean {
  if (!target || !(target instanceof Element)) return false
  const tag = target.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  if ((target as HTMLElement).isContentEditable) return true
  return false
}
