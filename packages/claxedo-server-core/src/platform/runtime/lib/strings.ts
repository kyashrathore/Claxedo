/**
 * Shared string primitives.
 *
 * `cleanString` existed as 18 byte-identical private copies across the package
 * (authority/, adapters/, routes/, billing/, workspace/, observability/,
 * governance/) before this module. They were consolidated because a helper
 * copy-pasted that many times drifts: three OTHER variants under the same
 * `clean` name are deliberately NOT folded in here, since they do different
 * things and quietly swapping them would change behavior —
 *
 *   - `clean(input: unknown)` in routes/hosted/device-auth.ts narrows a
 *     non-string input rather than assuming `string | undefined`, so it is not
 *     interchangeable with this one.
 *
 * That keeps its local definition. Only the exact-match set moved.
 */

/** Trim a possibly-absent string; empty/whitespace-only becomes undefined. */
export function cleanString(input: string | undefined): string | undefined {
  const value = input?.trim()
  return value ? value : undefined
}
