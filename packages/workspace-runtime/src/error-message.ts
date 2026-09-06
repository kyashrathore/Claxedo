import { rec, str } from "./json-value"

/**
 * The one way this package turns a thrown value into text.
 *
 * `catch (error)` binds `unknown`, and roughly twenty call sites had each
 * written their own `error instanceof Error ? error.message : String(error)`.
 * That tail is wrong for the case it exists to cover: `String(value)` on a
 * plain object yields `"[object Object]"`, so a rejected fetch, an ACP error
 * frame or a harness error payload became a log line and an HTTP error body
 * that said nothing at all.
 *
 * So a non-`Error` object is read for the message it carries — its own
 * `message`, or the `data.message` an engine error envelope uses — and falls
 * back to its JSON rather than to that placeholder.
 */
export function errorMessage(input: unknown): string {
  if (input instanceof Error) return input.message
  const row = rec(input)
  if (!row) return String(input)
  const message = str(row.message) ?? str(rec(row.data)?.message)
  if (message) return message
  try {
    return JSON.stringify(row) ?? String(input)
  } catch {
    // A cyclic or non-serializable payload: the keys still say more than
    // "[object Object]".
    return `{${Object.keys(row).join(", ")}}`
  }
}
