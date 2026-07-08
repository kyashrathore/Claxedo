export type ChannelId = "github" | "slack" | "telegram" | "discord" | "whatsapp"

export type Attachment = {
  id?: string
  name?: string
  mimeType?: string
  url?: string
  text?: string
}

/** Whether the inbound message came from a 1:1 DM or a group/room. */
export type ChannelChatType = "dm" | "group"

export type ChannelIntent =
  | { kind: "message" }
  | { kind: "approval_reply"; callId?: string; token?: string; approved: boolean }
  | { kind: "cancel"; sessionId?: string }
  | { kind: "new_session"; title?: string }
  | { kind: "list_sessions" }
  | { kind: "status" }
  | { kind: "whoami" }
  | { kind: "pairing_approve"; code: string }
  | { kind: "pairing_list" }

export type InboundEnvelope = {
  channel: ChannelId
  externalUserId: string
  threadKey: string
  idempotencyKey: string
  text: string
  receivedAt?: number
  /**
   * Direct message vs group. Access policy and mention-gating differ by type;
   * missing this was the root cause of OpenClaw's iMessage privacy leak (#2019).
   * Defaults to "dm" when an adapter can't classify (safer: DM policy is
   * stricter than group policy in a pairing-default posture).
   */
  chatType?: ChannelChatType
  /**
   * Set by trusted LOCAL injection paths (the loopback-gated fake transport)
   * to bypass the DM/group access gate + rate limit. NEVER set from a real
   * external webhook — those must always run the gate.
   */
  trustedSource?: boolean
  intent?: ChannelIntent
  mentions?: string[]
  repo?: { owner: string; name: string }
  attachments?: Attachment[]
  raw: unknown
}

export type OutboundChunk =
  | { kind: "text"; text: string; final: boolean }
  | { kind: "approval"; request: ApprovalRequest }
  | { kind: "status"; phase: "creating" | "running" | "done" | "failed"; sessionId?: string; appUrl?: string }

export type ApprovalRequest = { callId: string; tool: string; summary: string; sessionId: string; threadKey?: string; token?: string }
export type ApprovalDecision = {
  callId?: string
  token?: string
  approved: boolean
  actorExternalUserId: string
  threadKey?: string
}
