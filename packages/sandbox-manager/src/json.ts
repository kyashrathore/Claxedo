/**
 * Reading untrusted JSON: driver API responses, CLI output, stored records.
 *
 * Drivers all face the same problem — a provider hands back `any`, and the code
 * needs a few named fields out of it. Narrowing through these keeps the check
 * and the type in the same place, instead of each site asserting a shape it
 * never verified. The object check is `@claxedo/helpers/guards`, re-exported
 * under the names the drivers use.
 */

export { asRecord as record, isRecord } from "@claxedo/helpers/guards"

/** A non-empty string, or undefined — the shape almost every provider field wants. */
export function text(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

export function num(input: unknown): number | undefined {
  return typeof input === "number" ? input : undefined
}
