import { isRecord } from "./guards"

/**
 * Renders any thrown or streamed error value as a human-readable string.
 *
 * The `data`/`error` probe stays AHEAD of the `instanceof Error` check on
 * purpose: ACP's RequestError extends Error and carries the informative half in
 * `.data`, so an Error-first check makes the detail branch dead code.
 */
export function errorMessage(err: unknown, fallback?: string): string {
  const obj = isRecord(err) ? err : undefined
  if (obj) {
    const nested = [obj.data, obj.error].find((candidate): candidate is Record<string, unknown> =>
      isRecord(candidate),
    )
    const detail = [nested?.message, nested?.details, obj.error].find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    )
    if (detail !== undefined) {
      const outer = obj.message
      return typeof outer === "string" && outer.length > 0 && outer !== detail
        ? `${outer}: ${detail}`
        : detail
    }
  }
  if (err instanceof Error && err.message.length > 0) return err.message
  if (obj && typeof obj.message === "string" && obj.message.length > 0) return obj.message
  // Arrays carry no message field, so they reach the JSON encoding directly.
  if (obj || Array.isArray(err)) {
    try {
      const encoded = JSON.stringify(err)
      // "{}" carries nothing, and it is what every Error encodes to — its own
      // properties are non-enumerable — so that case belongs to the fallback.
      if (typeof encoded === "string" && encoded !== "{}") return encoded
    } catch {
      // Circular or BigInt payloads fall through to the caller's fallback.
    }
  }
  if (typeof err === "string" && err.length > 0) return err
  return fallback ?? String(err)
}
