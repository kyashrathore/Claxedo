export const isMac = typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)

export type Keybind = { key: string; ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }

export type KeyLabel =
  | "ctrl"
  | "alt"
  | "shift"
  | "meta"
  | "space"
  | "backspace"
  | "enter"
  | "tab"
  | "delete"
  | "home"
  | "end"
  | "pageUp"
  | "pageDown"
  | "insert"
  | "esc"

export type KeyLabeler = (key: KeyLabel) => string

function normalizeKey(key: string): string {
  if (key === ",") return "comma"
  if (key === "+") return "plus"
  if (key === " ") return "space"
  return key.toLowerCase()
}

export function keybindSignature(kb: Keybind): string {
  const mask = (kb.ctrl ? 1 : 0) | (kb.meta ? 2 : 0) | (kb.shift ? 4 : 0) | (kb.alt ? 8 : 0)
  return `${kb.key}:${mask}`
}

export function eventSignature(event: KeyboardEvent): string {
  return keybindSignature({ key: normalizeKey(event.key), ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey })
}

function applyPart(keybind: Keybind, part: string): void {
  if (part === "ctrl" || part === "control") keybind.ctrl = true
  else if (part === "meta" || part === "cmd" || part === "command") keybind.meta = true
  else if (part === "mod") {
    if (isMac) keybind.meta = true
    else keybind.ctrl = true
  } else if (part === "alt" || part === "option") keybind.alt = true
  else if (part === "shift") keybind.shift = true
  else keybind.key = part
}

export function parseKeybind(config: string): Keybind[] {
  if (!config || config === "none") return []
  return config.split(",").map((combo) => {
    const keybind: Keybind = { key: "", ctrl: false, meta: false, shift: false, alt: false }
    for (const part of combo.trim().toLowerCase().split("+")) applyPart(keybind, part)
    return keybind
  })
}

const symbolKeys: Record<string, string> = { arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", comma: ",", plus: "+" }

const namedKeys: Record<string, KeyLabel> = {
  backspace: "backspace",
  delete: "delete",
  end: "end",
  enter: "enter",
  esc: "esc",
  escape: "esc",
  home: "home",
  insert: "insert",
  pagedown: "pageDown",
  pageup: "pageUp",
  space: "space",
  tab: "tab",
}

function displayKey(key: string, label: KeyLabeler): string {
  const symbol = symbolKeys[key]
  if (symbol) return symbol
  const named = namedKeys[key]
  if (named) return label(named)
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1)
}

export function formatKeybindParts(config: string, label: KeyLabeler): string[] {
  const keybind = parseKeybind(config)[0]
  if (!keybind) return []
  const parts: string[] = []
  if (keybind.ctrl) parts.push(isMac ? "⌃" : label("ctrl"))
  if (keybind.alt) parts.push(isMac ? "⌥" : label("alt"))
  if (keybind.shift) parts.push(isMac ? "⇧" : label("shift"))
  if (keybind.meta) parts.push(isMac ? "⌘" : label("meta"))
  if (keybind.key) parts.push(displayKey(keybind.key.toLowerCase(), label))
  return parts
}

export function formatKeybind(config: string, label: KeyLabeler): string {
  const parts = formatKeybindParts(config, label)
  return isMac ? parts.join("") : parts.join("+")
}

export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target.closest("[contenteditable='true'], input, textarea, select") !== null
}
