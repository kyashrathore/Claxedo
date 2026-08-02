import type { ChannelIntent } from "../envelope"

/**
 * Strip leading bot mentions so `^`-anchored commands still match.
 *
 * GitHub only builds an envelope when the body mentions the bot
 * (`transport/github.ts`), so EVERY GitHub body contains `@claxedo` — without
 * this, no slash command on that channel could ever match.
 */
function withoutMentions(input: string, mentions: readonly string[] | undefined) {
  let text = input.trim()
  if (!mentions?.length) return text
  for (;;) {
    const hit = mentions.find((mention) => text.toLowerCase().startsWith(mention.toLowerCase()))
    if (!hit) return text
    text = text.slice(hit.length).trim()
  }
}

/**
 * Classify inbound text into a channel intent.
 *
 * Deliberately does NOT recognize approval replies. Approvals are decided by a
 * button press (structured, carries the token) or by the approval judge
 * (`core/approval-judge.ts`), which reads a free-text reply in the context of
 * the prompt it answers. A regex over prose cannot tell "no thanks" (a message)
 * from "no" (a denial), so it does not try — anything unrecognized here stays a
 * plain message and reaches the session intact.
 */
export function parseChannelCommand(input: string, options: { mentions?: readonly string[] } = {}): ChannelIntent {
  const trimmed = withoutMentions(input, options.mentions)
  const stopWithSession = trimmed.match(/^\/stop\s+(ses_[a-z0-9_:-]{1,124})$/i)
  if (stopWithSession) return { kind: "cancel", sessionId: stopWithSession[1] }
  if (/^\/stop(?:\s|$)/i.test(trimmed)) return { kind: "cancel" }
  // Session lifecycle + identity commands.
  const newSession = trimmed.match(/^\/new(?:\s+(.{1,120}))?$/i)
  if (newSession) return { kind: "new_session", ...(newSession[1] ? { title: newSession[1].trim() } : {}) }
  if (/^\/sessions(?:\s|$)/i.test(trimmed)) return { kind: "list_sessions" }
  if (/^\/status(?:\s|$)/i.test(trimmed)) return { kind: "status" }
  if (/^\/whoami(?:\s|$)/i.test(trimmed)) return { kind: "whoami" }
  // Pairing administration from an already-authorized sender.
  const pairingApprove = trimmed.match(/^\/pairing\s+approve\s+([A-Z2-9]{4,16})$/i)
  if (pairingApprove) return { kind: "pairing_approve", code: pairingApprove[1].toUpperCase() }
  if (/^\/pairing(?:\s+list)?$/i.test(trimmed)) return { kind: "pairing_list" }
  return { kind: "message" }
}
