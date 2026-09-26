// Reading fields off JSON nobody has validated.
//
// The harness consumes three kinds of unvalidated JSON: CDP trace payloads,
// another benchmark's `attempt.json`/`result.json` evidence, and NDJSON
// resource ticks. None has a schema here, so every field is `unknown` until it
// is checked. Before this module each reader asserted its own shape
// (`node.evidence as Array<Record<string, number>>`) and then coerced with
// `Number(...)`, which turns a missing field into `NaN` and an object into
// `"[object Object]"` without either being visible at the call site.
//
// These readers say what was actually found. A field that is not the type the
// caller wants reads as `undefined`, and the caller chooses the fallback in the
// open — `?? 0` where zero is a real answer, `?? NaN` where it is not.
//
// `compare/graded-analysis.ts` runs this module standalone under `bun` and
// must not pull the driver module graph (node:sqlite, playwright). Its only
// import is `@claxedo/helpers/guards`, which itself imports nothing.
import { isRecord } from "@claxedo/helpers/guards"

export { isRecord } from "@claxedo/helpers/guards"

/** Read `key` as a string, or `undefined` when it is absent or another type. */
export function textField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

/**
 * Read `key` as a number, or `undefined` when it is absent or unreadable.
 *
 * Numeric strings are accepted: evidence files written by other tools quote
 * timestamps, and the readers this replaced coerced them with `Number(...)`.
 */
export function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (typeof value === "number") return Number.isNaN(value) ? undefined : value
  if (typeof value !== "string" || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** Read `key` as a nested object, or `undefined` when it is absent or another type. */
export function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key]
  return isRecord(value) ? value : undefined
}

/**
 * Read `key` as an array of objects, dropping entries that are not objects.
 *
 * Returns `undefined` when the field is not an array at all, so a caller can
 * tell "no such evidence" from "evidence with nothing usable in it".
 */
export function recordsField(record: Record<string, unknown>, key: string): Record<string, unknown>[] | undefined {
  const value = record[key]
  return Array.isArray(value) ? value.filter(isRecord) : undefined
}
