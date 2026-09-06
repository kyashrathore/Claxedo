/**
 * Structural guards for values crossing a boundary into the contract types.
 *
 * A payload arriving as JSON, an IPC message, or a database row is `unknown`.
 * These guards are how it becomes typed: they narrow by checking, so nothing
 * downstream has to assert.
 */

export { asRecord, isRecord } from "@claxedo/helpers/guards"

/** The non-empty string `value` holds, or `undefined`. */
export function asText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}
