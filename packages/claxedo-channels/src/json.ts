/**
 * Reading untrusted JSON — webhook payloads from GitHub, Telegram, WhatsApp
 * and the chat SDKs, plus runtime event payloads.
 *
 * Six transports had each written their own two-line `record`/`text` pair and
 * asserted the shape inside it. One copy means one place to be right about
 * what "a JSON object" is, and callers narrow instead of asserting.
 */

export function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

export function record(input: unknown): Record<string, unknown> | undefined {
  return isRecord(input) ? input : undefined
}

/** A trimmed, non-empty string, or undefined. */
export function text(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

/** A string with visible content, returned exactly as sent (no trimming). */
export function filled(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input : undefined
}

/** A string exactly as sent, non-empty check only — for ids and opaque tokens. */
export function raw(input: unknown): string | undefined {
  return typeof input === "string" ? input : undefined
}

export function num(input: unknown): number | undefined {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}
