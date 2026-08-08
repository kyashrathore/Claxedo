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
 *   - `clean(input: unknown)` in hosts/workgraph/execution-capabilities.ts and
 *     composition/session-gateway.ts returns `value || undefined`, which also
 *     discards the string "0".
 *   - `clean(input: unknown)` in routes/hosted/device-auth.ts narrows a
 *     non-string input rather than assuming `string | undefined`.
 *
 * Those keep their local definitions. Only the exact-match set moved.
 */

/** Trim a possibly-absent string; empty/whitespace-only becomes undefined. */
export function cleanString(input: string | undefined): string | undefined {
  const value = input?.trim()
  return value ? value : undefined
}
