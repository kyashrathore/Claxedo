import { isRecord, num } from "../json"

/**
 * "Can a retry still fix this?" for driver errors.
 *
 * Every driver SDK throws its own error class, so the only surface they share
 * is an optional HTTP-ish status and some human text. Each driver used to cast
 * `unknown` to its own hand-written shape of that surface — five near-identical
 * copies, each one a claim the type system could not check. Reading the fields
 * once, here, keeps the shape in one place and keeps every driver honest about
 * what it actually inspected.
 */

function textOf(input: unknown): string {
  return typeof input === "string" ? input : ""
}

/** The status and lower-cased text a driver error carries, if it carries any. */
export function driverErrorSignals(err: unknown): { status: number | undefined; text: string } {
  const shaped = isRecord(err) ? err : {}
  const nested = isRecord(shaped.response) ? shaped.response : {}
  return {
    // `response.status` is the axios shape; `statusCode` is what SDK-native
    // error classes expose instead (@daytona/sdk's `DaytonaError`).
    status: num(nested.status) ?? num(shaped.status) ?? num(shaped.statusCode),
    text: `${textOf(shaped.code)} ${textOf(shaped.name)} ${textOf(shaped.message)}`.toLowerCase(),
  }
}

/**
 * A 5xx is transient for every driver; anything else is a per-driver judgment
 * made from the error text, so each driver passes the markers it has actually
 * seen its own SDK produce.
 */
export function isTransientDriverError(err: unknown, markers: readonly string[]): boolean {
  const { status, text } = driverErrorSignals(err)
  if (status !== undefined && status >= 500) return true
  return markers.some((marker) => text.includes(marker))
}
