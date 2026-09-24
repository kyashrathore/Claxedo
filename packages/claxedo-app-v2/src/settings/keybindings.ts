export type KeybindingRow = {
  readonly id: string
  readonly title: string
  readonly category: string
  readonly keybind: string
}

const IS_MAC = typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"])

function keyName(key: string): string {
  if (key === ",") return "comma"
  if (key === "+") return "plus"
  if (key === " ") return "space"
  return key.toLowerCase()
}

export function keybindingFromEvent(event: KeyboardEvent): string | undefined {
  if (MODIFIER_KEYS.has(event.key)) return undefined
  const parts: string[] = []
  if (IS_MAC ? event.metaKey : event.ctrlKey) parts.push("mod")
  if (IS_MAC && event.ctrlKey) parts.push("ctrl")
  if (!IS_MAC && event.metaKey) parts.push("meta")
  if (event.altKey) parts.push("alt")
  if (event.shiftKey) parts.push("shift")
  parts.push(keyName(event.key))
  return parts.join("+")
}

export function clearsKeybinding(event: KeyboardEvent): boolean {
  const modified = event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
  return !modified && (event.key === "Backspace" || event.key === "Delete")
}

export function groupRows(rows: readonly KeybindingRow[]): readonly (readonly [string, readonly KeybindingRow[]])[] {
  const grouped = new Map<string, KeybindingRow[]>()
  for (const row of rows) grouped.set(row.category, [...(grouped.get(row.category) ?? []), row])
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, list]) => [category, list.sort((a, b) => a.title.localeCompare(b.title))] as const)
}

export function filterRows(rows: readonly KeybindingRow[], query: string): readonly KeybindingRow[] {
  const value = query.trim().toLowerCase()
  if (!value) return rows
  return rows.filter((row) => row.title.toLowerCase().includes(value) || row.keybind.toLowerCase().includes(value))
}
