/**
 * Reading untrusted JSON — provider token and profile responses, stored
 * credential envelopes, webhook payloads.
 *
 * Every provider integration here answers `res.json()`, which is `any`. Each
 * one used to assert its own hoped-for shape and then re-check the fields it
 * cared about anyway; narrowing through these keeps the check and the type
 * together, so a provider that changes a field is a missing value at the read
 * rather than a type the code claimed but never verified.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/** A non-empty string, or undefined. */
export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

/** The string-valued entries of an object; anything else is dropped. */
export function stringRecord(value: unknown): Record<string, string> {
  const row = record(value)
  if (!row) return {}
  return Object.fromEntries(Object.entries(row).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

/** Reads an OWN property, so an inherited `toString`/`constructor` never masquerades as data. */
export function own(row: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(row, key) ? row[key] : undefined
}
