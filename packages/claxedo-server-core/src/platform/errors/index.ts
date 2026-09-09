import { isRecord } from "@claxedo/server-core/platform/json/index"

/**
 * The `errno` code of a Node system error (`ENOENT`, `EPERM`, `EEXIST`, …).
 *
 * Call sites used to write `(error as NodeJS.ErrnoException).code`, which is a
 * promise the `catch` block cannot keep: a rejected `fs` call is typed
 * `unknown`, and the thing thrown may be a `TypeError`, a string, or an abort
 * reason with no `code` at all. Reading the property through this returns
 * `undefined` for those instead of pretending they are system errors, so the
 * usual `if (code !== "ENOENT") throw error` rethrows them — which is what the
 * cast was already relying on by accident.
 */
export function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined
  const code = error.code
  return typeof code === "string" ? code : undefined
}

/**
 * A human-readable message for any thrown value.
 *
 * Thirty-odd sites in this package spell `error instanceof Error ?
 * error.message : String(error)` by hand; `String(error)` on a plain object
 * yields `"[object Object]"`, so the ones that hit a rejected fetch's cause or
 * a structured worker error logged nothing useful. This falls back to JSON
 * rather than to the default stringification.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (error === undefined || error === null) return ""
  if (isRecord(error)) {
    const message = error.message
    if (typeof message === "string") return message
    try {
      return JSON.stringify(error)
    } catch {
      return Object.prototype.toString.call(error)
    }
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") return String(error)
  // A symbol or a function: neither has a message, and `String()` on a symbol throws.
  return Object.prototype.toString.call(error)
}
