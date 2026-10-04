/**
 * String normalisation. Narrowing lives in `./guards`; this module returns a
 * CHANGED value, which is why `asString` and `trimToUndefined` are not neighbours.
 *
 * Its only import is `./guards`, so the `./string` subpath carries no host APIs
 * and stays valid on workerd and in the renderer, the same reason `./guards`
 * exists.
 */
import { isString } from "./guards"

/**
 * Returns the TRIMMED value, never the original. Arity is exactly 1 so it stays
 * usable point-free as `values.map(trimToUndefined)`.
 */
export function trimToUndefined(value: unknown): string | undefined {
  if (!isString(value)) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Total on `string`: callers feed the result straight into parameters typed
 * `string`, so blank input and wrong-type input are deliberately the same "".
 */
export function trimToEmpty(value: unknown): string {
  return isString(value) ? value.trim() : ""
}

/**
 * Normalizes a PEM carried in a single-line environment variable. The trim
 * happens BEFORE the escape rewrite, so a trailing literal `\n` survives as a
 * real trailing newline.
 */
export function normalizePem(value: unknown): string | undefined {
  const trimmed = trimToUndefined(value)
  return trimmed?.replaceAll("\\n", "\n")
}

/**
 * Parses an Authorization header carrying exactly one Bearer credential.
 * A credential containing whitespace or a comma is rejected, so a
 * multi-credential header yields undefined rather than a truncated token.
 */
export function bearerToken(header: string | null | undefined): string | undefined {
  if (!isString(header)) return undefined
  const match = /^Bearer\s+([^\s,]+)$/i.exec(header.trim())
  return match?.[1]
}

/**
 * Safe for concatenation into a RegExp source, but NOT inside a character
 * class: `-` and `/` are deliberately not escaped.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Non-ASCII is a separator, not a transliteration: "Ünïcode" becomes "n-code". */
export function slug(input: string | undefined, fallback = ""): string {
  const slugged = (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slugged.length > 0 ? slugged : fallback
}

/**
 * Allocation-free scan rather than `new TextEncoder().encode(v).byteLength`:
 * both produce identical numbers, but the callers here run per-character over a
 * terminal stream and over an entire in-memory conversation whose whole purpose
 * is to measure memory.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A well-formed surrogate pair is one 4-byte codepoint.
        bytes += 4
        index += 1
        continue
      }
      // A lone surrogate is what TextEncoder emits as U+FFFD: 3 bytes.
      bytes += 3
    } else {
      bytes += 3
    }
  }
  return bytes
}
