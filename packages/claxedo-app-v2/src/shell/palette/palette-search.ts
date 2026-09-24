import fuzzysort from "fuzzysort"
import type { CommandOption } from "./registrations"

export type PaletteRow = { readonly option: CommandOption; readonly category: string }

export type PaletteGroup = { readonly category: string; readonly rows: readonly PaletteRow[] }

function visible(options: readonly CommandOption[]): CommandOption[] {
  return options.filter((option) => !option.hidden && !option.disabled)
}

export function searchOptions(options: readonly CommandOption[], query: string, fallbackCategory: string): PaletteRow[] {
  const candidates = visible(options)
  const trimmed = query.trim()
  if (!trimmed) return candidates.map((option) => ({ option, category: option.category ?? fallbackCategory }))
  const results = fuzzysort.go(trimmed, candidates, { keys: ["title", "category", "description"], threshold: 0.3, limit: 80 })
  return results.map((result) => ({ option: result.obj, category: result.obj.category ?? fallbackCategory }))
}

export function groupRows(rows: readonly PaletteRow[]): PaletteGroup[] {
  const groups = new Map<string, PaletteRow[]>()
  for (const row of rows) {
    const list = groups.get(row.category)
    if (list) list.push(row)
    else groups.set(row.category, [row])
  }
  return [...groups].map(([category, list]) => ({ category, rows: list }))
}

export function rowId(option: CommandOption): string {
  return `palette-option-${option.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`
}
