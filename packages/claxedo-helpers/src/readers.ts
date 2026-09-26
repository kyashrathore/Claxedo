/**
 * Field readers for payloads that arrive as `unknown`: CDP results, IPC and
 * child-port messages, HTTP bodies, on-disk records. Each is total: a missing
 * key, a non-object source, or a field of another type all read as
 * `undefined`, so a caller composes one parse per payload without a cast.
 */
import { asBoolean, asFiniteNumber, asRecord, asString, isRecord } from "./guards"

export function readField(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined
}

export function readString(source: unknown, key: string): string | undefined {
  return asString(readField(source, key))
}

export function readFiniteNumber(source: unknown, key: string): number | undefined {
  return asFiniteNumber(readField(source, key))
}

export function readBoolean(source: unknown, key: string): boolean | undefined {
  return asBoolean(readField(source, key))
}

export function readRecord(source: unknown, key: string): Record<string, unknown> | undefined {
  return asRecord(readField(source, key))
}

/** Returns the field BY REFERENCE, like `asArray`, but `undefined` rather than `[]` when it is not an array. */
export function readArray(source: unknown, key: string): unknown[] | undefined {
  const field = readField(source, key)
  return Array.isArray(field) ? field : undefined
}
