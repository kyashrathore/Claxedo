/**
 * Structural guards for values crossing a boundary into the contract types.
 *
 * A payload arriving as JSON, an IPC message, or a database row is `unknown`.
 * These guards are how it becomes typed: they narrow by checking, so nothing
 * downstream has to assert.
 */

/** Is `value` a plain object — the shape every contract payload is carried in? */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** The record `value` holds, or `undefined` when it is not one. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/** The non-empty string `value` holds, or `undefined`. */
export function asText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}
