/**
 * Shared JSON-shape primitives.
 *
 * "Is this parsed value a plain object?" existed as fourteen private copies
 * across the package (agent-config/, agent-plugins/, authority/, credentials/,
 * session/, workspace/, platform/auth/) in two interchangeable flavours: a
 * `value is Record<string, unknown>` predicate and a converter returning
 * `undefined`. Both are here, so a boundary that parses JSON narrows it once
 * instead of re-deriving the test — and does it without an assertion, which is
 * what most of those copies used.
 *
 * Deliberately NOT folded in: copies that answer a different question under the
 * same name are left where they are —
 *
 *   - `record(input)` in session/navigation-list.ts substitutes `{}` for a
 *     non-object so its caller can index unconditionally, and
 *   - `objectRecord(input)` in agent-config/connections.ts returns a shallow
 *     copy rather than the value itself.
 *
 * Both are now expressed in terms of `jsonRecord` rather than repeating the
 * test.
 */

/** A parsed JSON object: not null, not an array, not a primitive. */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The same test as a converter, for call sites that want a value rather than a branch. */
export function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return isJsonRecord(value) ? value : undefined
}
