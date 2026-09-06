/**
 * Boundary narrowing for untyped values that reach the app as `unknown`
 * (HTTP JSON bodies, SDK event payloads, persisted storage, IPC metadata).
 *
 * These are type predicates rather than assertions so that a caller reads the
 * value through a real narrowing instead of an `as` cast at every property.
 * `typeof value === "object"` alone narrows to `object`, which TypeScript will
 * not let you index — reaching for `as Record<string, unknown>` there is the
 * single most duplicated cast in this package, and `isRecord` is its answer.
 */

/** True when `value` is a non-null, non-array object that can be indexed by string. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Narrow `value` to an indexable record, or `undefined` when it is not one. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/** Narrow `value` to an indexable record, falling back to an empty one. */
export function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/** Read `key` from `value` when it is a record, otherwise `undefined`. */
export function readField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

/** Read `key` from `value` when it is a record holding a string there. */
export function readString(value: unknown, key: string): string | undefined {
  const field = readField(value, key)
  return typeof field === "string" ? field : undefined
}

/**
 * Read `key` from `value` when it is a record holding a string or an explicit
 * `null` there.
 *
 * JSON DTOs in this app distinguish "absent" from "known to be nothing"
 * (`projectId?: string | null`), and {@link readString} collapses both to
 * `undefined`. Use this wherever the declared field admits `null`.
 */
export function readNullableString(value: unknown, key: string): string | null | undefined {
  const field = readField(value, key)
  if (field === null) return null
  return typeof field === "string" ? field : undefined
}

/** Read `key` from `value` when it is a record holding a finite number there. */
export function readFiniteNumber(value: unknown, key: string): number | undefined {
  const field = readField(value, key)
  return typeof field === "number" && Number.isFinite(field) ? field : undefined
}

/** Read `key` from `value` when it is a record holding a boolean there. */
export function readBoolean(value: unknown, key: string): boolean | undefined {
  const field = readField(value, key)
  return typeof field === "boolean" ? field : undefined
}

/** Read `key` from `value` when it is a record holding an array there. */
export function readArray(value: unknown, key: string): unknown[] | undefined {
  const field = readField(value, key)
  return Array.isArray(field) ? field : undefined
}

/**
 * Every string in `value` when it is an array, dropping entries that are not.
 *
 * `array.filter((item): item is string => typeof item === "string")` was
 * written out at eighteen boundaries in this package — provider catalogs,
 * persisted recency lists, Git ref lists, terminal argv. They all mean the
 * same thing, so they share one name.
 */
export function onlyStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/**
 * Read `key` from `value` when it is a record holding an array there, keeping
 * only its strings. `undefined` when the key holds no array — an absent list
 * and an all-non-string list are different facts, and callers that do not care
 * about the difference write `?? []`.
 */
export function readStringArray(value: unknown, key: string): string[] | undefined {
  const field = readArray(value, key)
  return field === undefined ? undefined : onlyStrings(field)
}
