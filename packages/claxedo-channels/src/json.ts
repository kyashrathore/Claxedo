/**
 * Reading untrusted JSON — webhook payloads from GitHub, Telegram, WhatsApp
 * and the chat SDKs, plus runtime event payloads.
 *
 * Six transports had each written their own two-line record and string readers and
 * asserted the shape inside it. One copy means one place to be right about
 * what "a JSON object" is, and callers narrow instead of asserting.
 */

export { isRecord, asRecord as record } from "@claxedo/helpers/guards"

/** A string with visible content, returned exactly as sent (no trimming). */
export function filled(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() ? input : undefined
}
