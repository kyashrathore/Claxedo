import type { CompatEnvelope, CompatEvent } from "./types"

export type { CompatEnvelope, CompatEvent } from "./types"

export type NormalizeCompatEventResult<Event extends CompatEvent = CompatEvent> = {
  event: Event
  issues: string[]
}

export function withDir<Event extends CompatEvent>(directory: string, payload: Event): CompatEnvelope<Event> {
  return { directory, payload }
}

export function normalizeCompatEventWithDiagnostics<Event extends CompatEvent>(event: Event): NormalizeCompatEventResult<Event> {
  const result = normalizeValue(event, new WeakSet())
  return {
    event: result.value as Event,
    issues: [...new Set(result.issues)],
  }
}

type NormalizeValueResult = {
  value: unknown
  issues: string[]
}

type NormalizedObjectEntry =
  | { key: string; value: unknown; issues: string[] }
  | { key: string; omit: true; issues: string[] }

function normalizeValue(value: unknown, seen: WeakSet<object>): NormalizeValueResult {
  if (value === undefined) return { value: undefined, issues: [] }
  if (value === null) return { value, issues: [] }
  if (typeof value === "bigint") return { value: value.toString(), issues: ["bigint"] }
  if (typeof value === "function") return { value: `[Function ${value.name || "anonymous"}]`, issues: ["function"] }
  if (typeof value === "symbol") return { value: String(value), issues: ["symbol"] }
  if (typeof value !== "object") return { value, issues: [] }
  if (seen.has(value)) return { value: "[Circular]", issues: ["circular"] }

  seen.add(value)
  if (Array.isArray(value)) {
    const items = value.map((item) => normalizeValue(item, seen))
    seen.delete(value)
    return {
      value: items.map((item) => item.value === undefined ? null : item.value),
      issues: items.flatMap((item) => item.issues),
    }
  }

  const entries: NormalizedObjectEntry[] = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    const normalized = normalizeValue(item, seen)
    return normalized.value === undefined
      ? { key, omit: true, issues: normalized.issues }
      : { key, value: normalized.value, issues: normalized.issues }
  })
  seen.delete(value)
  return {
    value: Object.fromEntries(entries.flatMap((entry) => "omit" in entry ? [] : [[entry.key, entry.value]])),
    issues: entries.flatMap((entry) => entry.issues),
  }
}
