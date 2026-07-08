import { createHash } from "node:crypto"

export type ParsedApprovalReply = {
  approved: boolean
  token: string
}

export function approvalToken(callId: string) {
  return createHash("sha256").update(callId).digest("hex").slice(0, 8)
}

export function parseApprovalReplyText(input: string): ParsedApprovalReply | undefined {
  const match = input.trim().match(/^(approve|allow|yes|deny|reject|no)\s+([a-z0-9_-]{3,64})$/i)
  if (!match) return
  return {
    approved: /^(approve|allow|yes)$/i.test(match[1]),
    token: match[2].toLowerCase(),
  }
}

export function parseChannelCommand(input: string) {
  const approval = parseApprovalReplyText(input)
  if (approval) return { kind: "approval_reply", approved: approval.approved, token: approval.token } as const
  const trimmed = input.trim()
  const stopWithSession = trimmed.match(/^\/stop\s+(ses_[a-z0-9_:-]{1,124})$/i)
  if (stopWithSession) return { kind: "cancel", sessionId: stopWithSession[1] } as const
  if (/^\/stop(?:\s|$)/i.test(trimmed)) return { kind: "cancel" } as const
  // Session lifecycle + identity commands (OpenClaw-inspired chat surface).
  const newSession = trimmed.match(/^\/new(?:\s+(.{1,120}))?$/i)
  if (newSession) return { kind: "new_session", ...(newSession[1] ? { title: newSession[1].trim() } : {}) } as const
  if (/^\/sessions(?:\s|$)/i.test(trimmed)) return { kind: "list_sessions" } as const
  if (/^\/status(?:\s|$)/i.test(trimmed)) return { kind: "status" } as const
  if (/^\/whoami(?:\s|$)/i.test(trimmed)) return { kind: "whoami" } as const
  // Pairing administration from an already-authorized sender.
  const pairingApprove = trimmed.match(/^\/pairing\s+approve\s+([A-Z2-9]{4,16})$/i)
  if (pairingApprove) return { kind: "pairing_approve", code: pairingApprove[1].toUpperCase() } as const
  if (/^\/pairing(?:\s+list)?$/i.test(trimmed)) return { kind: "pairing_list" } as const
  return { kind: "message" } as const
}
