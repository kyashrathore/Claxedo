/**
 * Reading untrusted JSON: driver API responses, CLI output, stored records.
 *
 * Drivers all face the same problem — a provider hands back `any`, and the code
 * needs a few named fields out of it. Narrowing through these keeps the check
 * and the type in the same place, instead of each site asserting a shape it
 * never verified.
 */

export function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

export function record(input: unknown): Record<string, unknown> | undefined {
  return isRecord(input) ? input : undefined
}

/** A non-empty string, or undefined — the shape almost every provider field wants. */
export function text(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

export function num(input: unknown): number | undefined {
  return typeof input === "number" ? input : undefined
}
