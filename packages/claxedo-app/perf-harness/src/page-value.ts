// What a browser-side function is allowed to have answered, after JSON transport.
//
// `BenchmarkPage.evaluate` runs a function that was `toString()`d and evaluated
// in the renderer, and gets the result back as JSON. TypeScript cannot relate
// the function's declared return type to what actually arrives — `() =>
// document.querySelector(x)` declares `Element | null` and arrives as `{}` — so
// an evaluation names a reader instead, and gets back only what the reader
// proved.
//
// Leniency is a per-reader decision, because the harness has two kinds of
// caller and they need opposite behavior:
//
//  - A polling caller (`waitFor`, `count`, the click/hover point reads) treats
//    an absent answer as "not ready yet, look again". Those use the readers
//    that answer `undefined`/`false`; a throw there would turn every transient
//    into a hard failure and destroy the retry.
//  - A measuring caller has already waited for its condition, so a missing
//    field means the page contract broke and the run's numbers are not real.
//    Those use the readers that throw.

import { isRecord, numberField } from "./json-fields"

/** Pass the page's answer through unread, for a caller that narrows it itself. */
export function rawValue(value: unknown): unknown {
  return value
}

/**
 * Only a literal `true` is true.
 *
 * Deliberately total: every caller is a readiness poll, and "the page answered
 * something other than true" and "the page is not ready" are the same answer.
 */
export function readFlag(value: unknown): boolean {
  return value === true
}

/** A boolean, or a failure naming what arrived instead. */
export function readBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`page evaluation answered ${describe(value)} where a boolean was required`)
  }
  return value
}

/** A number, or a failure naming what arrived instead. */
export function readNumber(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`page evaluation answered ${describe(value)} where a number was required`)
  }
  return value
}

/** A number, or `undefined` when the page did not produce one. */
export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && !Number.isNaN(value) ? value : undefined
}

/** A string, or a failure naming what arrived instead. */
export function readText(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`page evaluation answered ${describe(value)} where a string was required`)
  }
  return value
}

/** A string, or `undefined` when the page did not produce one. */
export function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** An object, or a failure naming what arrived instead. */
export function readRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`page evaluation answered ${describe(value)} where an object was required`)
  }
  return value
}

/** An object, or `undefined` when the page did not produce one. */
export function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/** An array, dropping nothing — entries stay `unknown` until the caller reads them. */
export function readList(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`page evaluation answered ${describe(value)} where an array was required`)
  }
  return value
}

/** An array of objects, or a failure; entries that are not objects are dropped. */
export function readRecords(value: unknown): Record<string, unknown>[] {
  return readList(value).filter(isRecord)
}

/**
 * Every named field as a number, or a failure naming the first one missing.
 *
 * This is the shape a timing evaluation answers — several `performance.now()`
 * marks resolved together — and it is the case where a silent `NaN` would be
 * published as a measurement.
 */
export function readNumberFields<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Record<Keys[number], number> {
  const record = readRecord(value)
  const read: Record<string, number> = {}
  for (const key of keys) {
    const found = numberField(record, key)
    if (found === undefined) {
      throw new Error(`page evaluation answered no number for ${key}: ${describe(value)}`)
    }
    read[key] = found
  }
  return read
}

/** Every named field as a boolean, or a failure naming the first one missing. */
export function readBooleanFields<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Record<Keys[number], boolean> {
  const record = readRecord(value)
  const read: Record<string, boolean> = {}
  for (const key of keys) read[key] = readBoolean(record[key])
  return read
}

/**
 * One of a fixed set of strings, or a failure naming what arrived.
 *
 * A discriminant the page echoes back is still a claim about another realm, and
 * this is what keeps it a literal type here instead of a widened `string`.
 */
export function readLiteral<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
): Values[number] {
  const text = readText(value)
  const found = allowed.find((candidate) => candidate === text)
  if (found === undefined) {
    throw new Error(`page evaluation answered ${JSON.stringify(text)}; expected one of ${allowed.join(", ")}`)
  }
  return found
}

/** A viewport-shaped answer: the two numbers a size read has to have. */
export function readSize(value: unknown): { width: number; height: number } {
  return readNumberFields(value, ["width", "height"])
}

/**
 * A viewport point, or `undefined` when the element was not there.
 *
 * The click and hover reads return `null` for a missing element on purpose, and
 * their callers raise a message naming the selector; this stays total so that
 * message survives.
 */
export function optionalPoint(value: unknown): { x: number; y: number } | undefined {
  const record = optionalRecord(value)
  if (!record) return undefined
  const x = optionalNumber(record.x)
  const y = optionalNumber(record.y)
  return x === undefined || y === undefined ? undefined : { x, y }
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined"
  // `JSON.stringify` answers `undefined` for a function or a symbol, and throws
  // on a cycle or a BigInt. Both fall back to the tag rather than to `String`,
  // which would report a plain object as "[object Object]" while claiming to
  // have read it.
  try {
    return JSON.stringify(value) ?? Object.prototype.toString.call(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}
