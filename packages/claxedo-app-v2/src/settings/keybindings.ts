export type KeybindingGroup = "general" | "session" | "navigation" | "model" | "terminal" | "prompt"

export const KEYBINDING_GROUPS: readonly KeybindingGroup[] = ["general", "session", "navigation", "model", "terminal", "prompt"]

export type KeybindingRow = {
  readonly id: string
  readonly title: string
  readonly group: KeybindingGroup
  readonly keybind: string | undefined
}

export const PALETTE_COMMAND_ID = "command.palette"

const IS_MAC = typeof navigator === "object" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)

export function groupFor(id: string): KeybindingGroup {
  if (id === PALETTE_COMMAND_ID) return "general"
  if (id.startsWith("terminal.")) return "terminal"
  if (id.startsWith("model.") || id.startsWith("agent.") || id.startsWith("mcp.")) return "model"
  if (id.startsWith("file.") || id.startsWith("fileTree.")) return "navigation"
  if (id.startsWith("prompt.")) return "prompt"
  const session = ["session.", "message.", "permissions.", "steps.", "review."]
  return session.some((prefix) => id.startsWith(prefix)) ? "session" : "general"
}

function isModifier(key: string) {
  return key === "Shift" || key === "Control" || key === "Alt" || key === "Meta"
}

function normalizeKey(key: string) {
  if (key === ",") return "comma"
  if (key === "+") return "plus"
  if (key === " ") return "space"
  return key.toLowerCase()
}

export function recordKeybind(event: KeyboardEvent): string | undefined {
  if (isModifier(event.key)) return undefined
  const parts: string[] = []
  const mod = IS_MAC ? event.metaKey : event.ctrlKey
  if (mod) parts.push("mod")
  if (IS_MAC && event.ctrlKey) parts.push("ctrl")
  if (!IS_MAC && event.metaKey) parts.push("meta")
  if (event.altKey) parts.push("alt")
  if (event.shiftKey) parts.push("shift")
  const key = normalizeKey(event.key)
  if (!key) return undefined
  parts.push(key)
  return parts.join("+")
}

export function keybindSignature(keybind: string | undefined): string[] {
  if (!keybind || keybind === "none") return []
  return keybind.split(",").map((chord) => {
    const parts = chord.trim().toLowerCase().split("+").filter(Boolean)
    const mod = parts.includes("mod")
    const ordered = [
      ...((parts.includes("ctrl") || (mod && !IS_MAC)) ? ["ctrl"] : []),
      ...(parts.includes("alt") ? ["alt"] : []),
      ...(parts.includes("shift") ? ["shift"] : []),
      ...((parts.includes("meta") || (mod && IS_MAC)) ? ["meta"] : []),
      ...parts.filter((part) => !["mod", "ctrl", "alt", "shift", "meta"].includes(part)),
    ]
    return ordered.join("+")
  }).filter(Boolean)
}

export function groupRows(rows: readonly KeybindingRow[]): ReadonlyMap<KeybindingGroup, KeybindingRow[]> {
  const grouped = new Map<KeybindingGroup, KeybindingRow[]>(KEYBINDING_GROUPS.map((group) => [group, []]))
  for (const row of rows) grouped.get(row.group)?.push(row)
  for (const list of grouped.values()) list.sort((a, b) => a.title.localeCompare(b.title))
  return grouped
}

export function filterRows(rows: readonly KeybindingRow[], query: string): KeybindingRow[] {
  const value = query.trim().toLowerCase()
  if (!value) return [...rows]
  return rows.filter((row) => row.title.toLowerCase().includes(value) || (row.keybind ?? "").toLowerCase().includes(value))
}

export function conflictsFor(rows: readonly KeybindingRow[], id: string, keybind: string): KeybindingRow[] {
  const signatures = new Set(keybindSignature(keybind))
  return rows.filter((row) => row.id !== id && keybindSignature(row.keybind).some((signature) => signatures.has(signature)))
}
