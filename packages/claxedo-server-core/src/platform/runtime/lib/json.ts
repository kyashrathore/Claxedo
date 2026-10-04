/**
 * Shared JSON-shape primitives.
 *
 * "Is this parsed value a plain object?" existed as fourteen private copies
 * across the package (agent-config/, agent-plugins/, authority/, credentials/,
 * session/, workspace/, platform/auth/) in two interchangeable flavours: a
 * `value is Record<string, unknown>` predicate and a converter returning
 * `undefined`. Both are here, so a boundary that parses JSON narrows it once
 * instead of re-deriving the test — and does it without an assertion, which is
 * what most of those copies used.
 *
 * Deliberately NOT folded in: copies that answer a different question under the
 * same name are left where they are —
 *
 *   - `record(input)` in session/navigation-list.ts substitutes `{}` for a
 *     non-object so its caller can index unconditionally, and
 *   - `objectRecord(input)` in agent-config/connections.ts returns a shallow
 *     copy rather than the value itself.
 *
 * Both are now expressed in terms of `jsonRecord` rather than repeating the
 * test.
 */

import { trimToUndefined } from "@claxedo/helpers/string"

/** A parsed JSON object: not null, not an array, not a primitive. */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The same test as a converter, for call sites that want a value rather than a branch. */
export function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return isJsonRecord(value) ? value : undefined
}

/** Parse a JSON string into a record; anything that is not a JSON object is `undefined`. */
export function parseJsonRecord(input: string): Record<string, unknown> | undefined {
  try {
    return jsonRecord(JSON.parse(input))
  } catch {
    return undefined
  }
}

/** A record whose values are ALL strings; a single non-string value rejects the whole record. */
export function jsonStringRecord(value: unknown): Record<string, string> | undefined {
  const row = jsonRecord(value)
  if (!row) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(row)) {
    if (typeof entry !== "string") return undefined
    out[key] = entry
  }
  return out
}

/** The string-valued entries of a record, dropping the rest. */
export function jsonStringEntries(value: unknown): Record<string, string> {
  const row = jsonRecord(value)
  if (!row) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(row)) {
    if (typeof entry === "string") out[key] = entry
  }
  return out
}

/**
 * A value when it is a non-empty string.
 *
 * Deliberately untrimmed, unlike `isNonEmptyString`: credential parsers use it
 * to pick the first populated spelling of a token out of a provider blob, and
 * a token's own bytes are not theirs to alter.
 */
export function jsonNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function jsonString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** A record's field, trimmed, when it holds a non-blank string. */
export function jsonText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? trimToUndefined(value) : undefined
}

/** A present, non-blank string field. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

/**
 * A parsed value that is one of a closed set of strings.
 *
 * This is how a boundary narrows JSON to a string-union member. It replaces the
 * `membership.has(value as Union)` shape, which asks the set a question it has
 * already been told the answer to and narrows nothing.
 */
export function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === "string" && values.some((entry) => entry === value)
}
