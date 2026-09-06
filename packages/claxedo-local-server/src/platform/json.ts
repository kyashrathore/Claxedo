/**
 * Reading untrusted JSON — request bodies, runtime event payloads, subprocess
 * output, files written by other tools.
 *
 * The object check is `@claxedo/helpers/guards`, re-exported here so callers
 * narrow through one owner instead of asserting.
 *
 * `isRecord` is the predicate, for a guard or a `&&` chain; `record` is the
 * same test as a converter, for a call site that wants a value rather than a
 * branch. The string readers differ in whether they trim and whether they
 * accept `""`, which is why there are four of them — pick by what the field is.
 */
import { asRecord, isRecord } from "@claxedo/helpers/guards"

export { asRecord as record, isRecord } from "@claxedo/helpers/guards"

/** A string with visible content, returned exactly as sent (no trimming). */
export function text(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input : undefined
}

/** A trimmed, non-empty string — for names and identifiers read from a request. */
export function trimmed(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

/** A string exactly as sent, non-empty check only — for ids and opaque tokens. */
export function raw(input: unknown): string | undefined {
  return typeof input === "string" ? input : undefined
}

export function num(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

export function bool(input: unknown): boolean | undefined {
  return typeof input === "boolean" ? input : undefined
}

/** The string-valued entries of an object; anything else is dropped. */
export function stringRecord(input: unknown): Record<string, string> {
  const row = asRecord(input)
  if (!row) return {}
  return Object.fromEntries(Object.entries(row).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}
