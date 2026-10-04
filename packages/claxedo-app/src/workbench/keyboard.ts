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
