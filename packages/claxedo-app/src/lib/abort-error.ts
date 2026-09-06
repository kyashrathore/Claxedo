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

/**
 * True for a request this app itself gave up on: an `AbortError`, or the
 * `CancelledError` TanStack Query raises when a query is cancelled.
 *
 * Callers use it to stay silent — a cancellation is not a failure to report —
 * so both names have to be covered. `providers/file.tsx` and
 * `platform/files/tree-store.ts` each carried a byte-identical private copy.
 */
export function isCancelledError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === "CancelledError" || error.name === "AbortError" || error.message === "CancelledError"
}
