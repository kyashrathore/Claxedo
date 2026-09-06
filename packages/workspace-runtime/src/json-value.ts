/**
 * The `unknown`-boundary narrowing primitives for this package.
 *
 * Every place that reads a JSON column, an engine event payload, an operator
 * config value or a relay frame faces the same problem: a value typed `unknown`
 * that must be inspected field by field. These are that inspection, declared
 * once, so the checks stay identical at every boundary instead of being
 * re-derived — and drifting — in each module. Three separate copies of `rec`
 * had already diverged on whether an array counts as a record.
 *
 * They narrow; they never assert. A caller that needs a richer shape composes
 * them (`str(rec(rec(x)?.data)?.message)`) rather than reaching for `as`.
 */

/** The one plain-object test: a JSON object, never an array and never `null`. */
export function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
}

/** The record view of `input`, or `undefined` when it is not a plain object. */
export function rec(input: unknown): Record<string, unknown> | undefined {
  return isRecord(input) ? input : undefined
}

/** The string value of `input`, or `undefined` when it is not a string. */
export function str(input: unknown): string | undefined {
  return typeof input === "string" ? input : undefined
}

/** The number value of `input`, or `undefined` when it is not a number. */
export function num(input: unknown): number | undefined {
  return typeof input === "number" ? input : undefined
}

/** The boolean value of `input`, or `undefined` when it is not a boolean. */
export function bool(input: unknown): boolean | undefined {
  return typeof input === "boolean" ? input : undefined
}

/** The array view of `input`, or `undefined` when it is not an array. */
export function arr(input: unknown): unknown[] | undefined {
  return Array.isArray(input) ? input : undefined
}

/**
 * `JSON.parse` that yields a record, or `undefined` for empty input, invalid
 * JSON, or a JSON scalar/array. The single place this package turns a config
 * or header string into an inspectable object.
 */
export function parseRecord(input: string | undefined): Record<string, unknown> | undefined {
  if (!input) return undefined
  try {
    return rec(JSON.parse(input))
  } catch {
    return undefined
  }
}
