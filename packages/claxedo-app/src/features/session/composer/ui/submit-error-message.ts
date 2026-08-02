/**
 * Pull a human message out of a submit failure.
 *
 * Extracted from `submit.ts` because that file sits ON the architecture guard's
 * 800-line hard cap, which cannot be allowlisted — so any new field there has to
 * be paid for by moving something out. This helper is the cleanest candidate: it
 * is pure, has no reactive dependencies, and takes its fallback as an argument
 * rather than reaching for the i18n context.
 *
 * The shape check comes first because the SDK's rejections carry the useful text
 * on `data.message`, while `Error.message` is often just the transport's status.
 */
export function submitErrorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "data" in err) {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
  }
  if (err instanceof Error) return err.message
  return fallback
}
