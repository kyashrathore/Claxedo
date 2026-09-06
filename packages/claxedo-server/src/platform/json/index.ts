/**
 * Narrowing for values that arrive from a boundary as `unknown` or `any`: JSON
 * request bodies, stored object blobs, database JSON columns, IPC payloads.
 *
 * Every such value used to be cast into its expected shape at the point of use,
 * which meant the question "did anyone actually check this was an object?" had a
 * different answer in each module. These guards are the single owner of that
 * check, so a boundary either narrows through them or is validated by a schema.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** `undefined` unless the value is a plain object, so callers can `?.` straight through. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

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
