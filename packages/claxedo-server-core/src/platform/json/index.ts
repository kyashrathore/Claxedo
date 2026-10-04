/**
 * Narrowing for values that arrive from a boundary as `unknown` or `any`: JSON
 * request bodies, stored object blobs, database JSON columns, IPC payloads.
 *
 * The object check itself is `@claxedo/helpers/guards`; this module re-exports
 * it so a boundary either narrows through one owner or is validated by a
 * schema, and adds the JSON-text and Request/Response readers built on it.
 */
import { asRecord, isRecord } from "@claxedo/helpers/guards"

export { asRecord, isRecord } from "@claxedo/helpers/guards"

/** `JSON.parse` with an honest return type: the result of parsing is `unknown`, never `any`. */
export function parseJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text)
  return parsed
}

/** `undefined` for malformed JSON as well as for well-formed JSON that is not an object. */
export function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(parseJson(text))
  } catch {
    return undefined
  }
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

/**
 * The one way a route or client reads a JSON object out of a `Request` or
 * `Response`.
 *
 * `.json()` is declared `Promise<any>`, so every reader used to write
 * `await c.req.json().catch(() => ({})) as { … }` and pick its own answers to
 * three questions: what a malformed body is, what a body that parses to a
 * non-object is, and what the fields are actually typed as. The first two are
 * the same answer everywhere — there is nothing to read — and the third is the
 * caller's own business, done on a `Record<string, unknown>` where the field
 * checks are visible.
 */
export async function readJsonRecord(
  source: { json(): Promise<unknown> },
): Promise<Record<string, unknown> | undefined> {
  return asRecord(await source.json().catch(() => undefined))
}

export function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord)
}

/**
 * A JSON array of objects — the shape every `wrangler ... --json` reader in
 * `scripts/deploy` consumes. `undefined` for malformed JSON, for a value that
 * is not an array, and for an array carrying anything but objects; each reader
 * used to assert all three at once with a single `as Array<{ … }>`.
 */
export function parseJsonRecords(text: string): Record<string, unknown>[] | undefined {
  try {
    const parsed = parseJson(text)
    return isRecordArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** A string field of a boundary record, or `undefined` when it is absent or another type. */
export function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" ? value : undefined
}

/** A finite-number field of a boundary record, or `undefined` when it is absent or another type. */
export function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
