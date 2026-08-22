/**
 * True for the platform abort shape: a non-null, non-array object whose `name`
 * reads "AbortError" (own or prototype property, so DOMException matches).
 * Mirrors the zod schema it replaced (`z.object({ name: z.literal("AbortError")
 * }).safeParse(x).success`) so abort classification never drags zod onto the
 * boot path.
 */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    !Array.isArray(error) &&
    (error as { name?: unknown }).name === "AbortError"
  )
}
