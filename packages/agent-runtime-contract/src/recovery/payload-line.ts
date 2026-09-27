

/**
 * Marks the line carrying a recovery tool's JSON payload.
 *
 * A tool answers in two parts — a sentence a person reads, then the payload a
 * renderer decodes — and they arrive joined into one string. Without a marker a
 * reader has to guess where the prose stops, and the first guess (the first
 * line opening a brace) silently lost the payload as soon as the prose above it
 * changed shape.
 */
export const RECOVERY_PAYLOAD_PREFIX = "recovery-payload: "

/**
 * The payload a recovery tool marked, or nothing when the text carries none.
 *
 * The last marked line wins. An owner's prose precedes the payload and may
 * quote a marker back — a refusal message repeating what a caller sent, for
 * instance — and the tool writes its own payload last, so reading from the end
 * cannot be talked into decoding someone's quotation instead.
 */
export function readRecoveryPayloadLine(text: string): string | undefined {
  const lines = text.split("\n")
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index]?.trimStart() ?? ""
    if (trimmed.startsWith(RECOVERY_PAYLOAD_PREFIX)) return trimmed.slice(RECOVERY_PAYLOAD_PREFIX.length)
  }
  return undefined
}
