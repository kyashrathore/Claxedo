export type ChannelId = "github" | "slack" | "telegram" | "discord" | "whatsapp"

/**
 * A callback whose return value is discarded, awaited if it happens to be a
 * promise.
 *
 * `void | Promise<void>` reads as the same thing but is not: a function
 * returning anything else — an `Array.push` returning a number, the commonest
 * shape a caller writes — is NOT assignable to it, because `void` inside a
 * union loses the special "return type is ignored" rule it has on its own.
 * `unknown` leaves the callback's own result unconstrained while still awaiting
 * a promise, which is the contract every one of these sinks actually wants.
 */
export type ChannelSink<TArgs extends unknown[]> = (...args: TArgs) => unknown

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
   * Direct message vs group. Access policy and mention-gating both differ by
   * chat type, so an unclassified message must not be treated as either by
   * accident. Defaults to "dm" when an adapter can't classify, because DM
   * policy is the stricter of the two in a pairing-default posture.
   */
  chatType?: ChannelChatType
  /**
   * Set by trusted LOCAL injection paths (the loopback-gated fake transport)
   * to bypass the DM/group access gate + rate limit. NEVER set from a real
   * external webhook — those must always run the gate.
   */
  trustedSource?: boolean
  intent?: ChannelIntent
  /**
   * Bot-mention tokens found in `text`. Empty means the message did not address
   * the bot, which is what group mention-gating keys off — so a transport that
   * cannot detect mentions must leave this empty rather than guessing, or an
   * unaddressed group message would be treated as a request to the bot.
   */
  mentions?: string[]
  repo?: { owner: string; name: string }
  attachments?: Attachment[]
  raw: unknown
}

export type OutboundChunk =
  | { kind: "text"; text: string; final: boolean }
  | { kind: "approval"; request: ApprovalRequest }
  | { kind: "status"; phase: "creating" | "running" | "done" | "failed"; sessionId?: string; appUrl?: string }

export type ApprovalRequest = {
  callId: string
  tool: string
  summary: string
  sessionId: string
  threadKey?: string
  token?: string
  /**
   * The sender whose turn raised this prompt, and therefore the only one whose
   * answer counts. In a group, everyone can see the card and press its buttons,
   * so without this an onlooker could approve a tool call on someone else's
   * behalf. Absent → any admitted actor in the matching thread may answer
   * (a DM-shaped prompt with a single participant).
   */
  requestee?: string
}
export type ApprovalDecision = {
  callId?: string
  token?: string
  approved: boolean
  actorExternalUserId: string
  threadKey?: string
}
