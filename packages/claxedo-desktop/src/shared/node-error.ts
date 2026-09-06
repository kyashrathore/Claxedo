import { readString } from "./json-read"

/**
 * The `code` of a Node syscall failure (`ENOENT`, `EEXIST`, `EADDRINUSE`, …).
 *
 * A `catch` binding is `unknown` and `Error` declares no `code`, so every
 * caller that wanted one used to assert `error as NodeJS.ErrnoException` —
 * a claim that is false for the plenty of thrown values that are not syscall
 * errors at all. This reads the field instead and answers `undefined` when it
 * is absent, so `nodeErrorCode(error) === "ENOENT"` is exactly as strong as
 * the check it replaces and no stronger.
 */
export function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error ? readString(error, "code") : undefined
}
