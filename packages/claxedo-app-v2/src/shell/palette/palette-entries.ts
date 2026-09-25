import type { Placement } from "@/server"
import type { SessionRowView } from "@/session"
import { SUGGESTED_PREFIX, type CommandOption } from "./registrations"

export type PaletteEntry = {
  readonly id: string
  readonly type: "command" | "file" | "session"
  readonly title: string
  readonly description?: string
  readonly keybind?: string
  readonly category: string
  readonly option?: CommandOption
  readonly path?: string
  readonly row?: SessionRowView
  readonly updated?: number
}

export const ENTRY_LIMIT = 5
export const OPEN_FILE_COMMAND = "file.open"
const COMMON_COMMAND_IDS = ["session.new", "workspace.new", "session.previous", "session.next", "terminal.new", "review.toggle"] as const

export function commandEntry(option: CommandOption, category: string, keybind: string | undefined): PaletteEntry {
  return { id: `command:${option.id}`, type: "command", title: option.title, description: option.description, keybind, category, option }
}

export function fileEntry(path: string, category: string): PaletteEntry {
  return { id: `file:${path}`, type: "file", title: path, category, path }
}

export function sessionEntry(row: SessionRowView, input: { readonly title: string; readonly description: string; readonly category: string }): PaletteEntry {
  return {
    id: `session:${row.ref.placementId}:${row.ref.sessionId}`,
    type: "session",
    title: input.title,
    description: input.description,
    category: input.category,
    row,
    updated: row.updatedAt,
  }
}

export function paletteCommands(options: readonly CommandOption[]): CommandOption[] {
  return options.filter((option) => !option.disabled && !option.hidden && !option.id.startsWith(SUGGESTED_PREFIX) && option.id !== OPEN_FILE_COMMAND)
}

export function commonCommands(options: readonly CommandOption[]): CommandOption[] {
  const order = new Map<string, number>(COMMON_COMMAND_IDS.map((id, index) => [id, index]))
  const picked = options.filter((option) => order.has(option.id))
  if (picked.length === 0) return options.slice(0, ENTRY_LIMIT)
  return [...picked].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}

export function workspaceKind(placement: Placement): "project" | "sandbox" {
  return placement.kind === "folder" ? "project" : "sandbox"
}

export type AgeKey = "shell.time.justNow" | "shell.time.minutesAgo" | "shell.time.hoursAgo" | "shell.time.daysAgo"

export function relativeAge(at: number, now: number): { readonly key: AgeKey; readonly count: number } {
  const seconds = Math.floor((now - at) / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (seconds < 60) return { key: "shell.time.justNow", count: 0 }
  if (minutes < 60) return { key: "shell.time.minutesAgo", count: minutes }
  if (hours < 24) return { key: "shell.time.hoursAgo", count: hours }
  return { key: "shell.time.daysAgo", count: Math.floor(hours / 24) }
}
