import { isRecord } from "@claxedo/helpers/guards"

export type ComboChoice = { readonly value: string; readonly label: string; readonly description?: string }

export function boundChoices(value: unknown): ComboChoice[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.value !== "string" || typeof entry.label !== "string") return []
    return [{ value: entry.value, label: entry.label, ...(typeof entry.description === "string" ? { description: entry.description } : {}) }]
  })
}

export function matchingChoices(choices: readonly ComboChoice[], query: string, filterLocally: boolean): readonly ComboChoice[] {
  const needle = query.trim().toLowerCase()
  if (!filterLocally || needle === "") return choices
  return choices.filter((choice) => `${choice.label} ${choice.description ?? ""}`.toLowerCase().includes(needle))
}

export function chosenValues(value: unknown, multiple: boolean): string[] {
  if (multiple) return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
  return typeof value === "string" && value !== "" ? [value] : []
}

export function choose(current: readonly string[], value: string, multiple: boolean): string[] {
  if (!multiple) return [value]
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
}

export function steppedActive(active: number, step: 1 | -1, count: number): number {
  if (count === 0) return -1
  if (active < 0) return step === 1 ? 0 : count - 1
  return (active + step + count) % count
}
