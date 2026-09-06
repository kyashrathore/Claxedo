/**
 * Reading untrusted JSON — HTTP bodies from the control plane, the documents
 * service, and the desktop bridge.
 *
 * The rule this package already states for `Request` in documents-tools.ts —
 * "`Promise<unknown>` rather than `<Result>(…) => Promise<Result>`: the generic
 * form let a caller name any return type and receive it unchecked" — needs
 * somewhere for the narrowing to live. This is that place, so every reader
 * narrows the same way instead of re-deriving a private copy.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/** A non-blank string, trimmed of nothing — callers that need trimming do it. */
export function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

/** The record members of an array value; anything else is dropped. */
export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

/** The string members of an array value; anything else is dropped. */
export function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) if (typeof item === "string") out.push(item)
  return out
}

/** The string-valued members of a record; anything else is dropped. */
export function stringRecord(value: unknown): Record<string, string> | undefined {
  const row = record(value)
  if (!row) return undefined
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(row)) if (typeof item === "string") out[key] = item
  return out
}

/**
 * The member of `values` equal to `value`, or undefined.
 *
 * `values.includes(value)` proves nothing to the checker, so the usual spelling
 * ends in a cast. `find` returns the union member itself, which is the same
 * check with the narrowing already done.
 */
export function oneOf<Value extends string>(value: unknown, values: readonly Value[]): Value | undefined {
  return values.find((candidate) => candidate === value)
}
