import type { ApprovalDecision, InboundEnvelope, OutboundChunk } from "../envelope"
import type { DedupStore } from "./dedup"
import type { ApprovalBridge } from "./approval-bridge"
import type { ChannelAccess, ChannelDenialReason } from "./access"
import { rateLimitKey, type RateLimiter } from "./rate-limit"
import { streamRuntimeReplies } from "./reply-sink"
import { ChannelSessionResolutionError, type ChannelRuntime, type SessionResolver } from "./resolve-session"

export type ChannelSessionSummary = {
  sessionId: string
  title?: string
  appUrl?: string
  updatedAt?: number
}

export type ChannelCore = {
  handleInbound(input: InboundEnvelope, handlers: { reply: (chunk: OutboundChunk) => void | Promise<void> }): Promise<void>
  onApproval(input: ApprovalDecision): Promise<{ ok: true } | { ok: false; message: string }>
}

export function createChannelCore(input: {
  runtime: ChannelRuntime
  dedup: DedupStore
  sessions: SessionResolver
  approvals?: ApprovalBridge
  /** DM/group access gate; runs FIRST, before dedup/session/LLM. */
  access?: ChannelAccess
  /** Per-sender inbound rate limit for ALLOWED senders. */
  rateLimiter?: RateLimiter
  /** Owner-visible audit sink for refused inbounds (never replies to sender). */
  onDenial?: (envelope: InboundEnvelope, reason: ChannelDenialReason | "rate_limited") => void | Promise<void>
  /** Gate for in-chat `/pairing approve|list`. Absent → in-chat admin refused. */
  canAdminister?: (envelope: InboundEnvelope) => boolean | Promise<boolean>
  /** Drop the thread→session binding so the next message starts fresh (/new). */
  resetSession?: (threadKey: string) => Promise<void>
  /** List this sender's sessions for /sessions. */
  listSessions?: (input: { channel: string; externalUserId: string }) => Promise<ChannelSessionSummary[]>
  /**
   * Pre-dispatch budget veto (OpenClaw's #42475 wish: a guardrail between "I
   * approved this sender" and "it spent all night"). Checked ONLY for message
   * turns, AFTER access/rate-limit but BEFORE session/LLM. A refusal replies
   * once (a daily-cap notice is useful, not amplifying spam like rate-limit).
   */
  budget?: (envelope: InboundEnvelope) => Promise<{ ok: true } | { ok: false; message: string }>
  authorize?: (input: InboundEnvelope, context?: {
    existingSession?: Awaited<ReturnType<SessionResolver["get"]>>
    action: "message" | "approval" | "cancel"
  }) => Promise<{ ok: true } | { ok: false; message: string }>
}): ChannelCore {
  const approvals = input.approvals
  return {
    async handleInbound(envelope, handlers) {
      // 1. ACCESS GATE — before any other work (dedup/session/LLM). A refused
      //    stranger costs at most one throttled pairing reply; denials go to
      //    the owner audit, not back to the sender (anti-amplification).
      //    Trusted local injection (loopback fake transport) bypasses it.
      if (input.access && !envelope.trustedSource) {
        const decision = await input.access.gate(envelope)
        if (decision.admission === "drop") {
          await input.onDenial?.(envelope, decision.reason)
          if (decision.reply) await handlers.reply({ kind: "text", text: decision.reply, final: true })
          return
        }
      }

      // 2. PER-SENDER RATE LIMIT — an allowed-but-abusive sender is still
      //    bounded before reaching a session/turn. Silent drop (no reply) so
      //    the limiter itself can't be turned into an outbound amplifier.
      if (input.rateLimiter && !envelope.trustedSource) {
        const rl = input.rateLimiter.check(rateLimitKey(envelope.channel, envelope.externalUserId), envelope.receivedAt)
        if (!rl.allowed) {
          await input.onDenial?.(envelope, "rate_limited")
          return
        }
      }

      // 3. IDENTITY / LIFECYCLE COMMANDS that need no session.
      const intent = envelope.intent
      if (intent?.kind === "whoami") {
        await handlers.reply({
          kind: "text",
          text: `Your sender id is ${envelope.channel}:${envelope.externalUserId}. An owner allowlists this exact id.`,
          final: true,
        })
        return
      }
      if (intent?.kind === "pairing_list" || intent?.kind === "pairing_approve") {
        const isAdmin = input.canAdminister ? await input.canAdminister(envelope) : false
        if (!isAdmin || !input.access) {
          await handlers.reply({ kind: "text", text: "Pairing administration is not available from this chat.", final: true })
          return
        }
        if (intent.kind === "pairing_list") {
          const pending = await input.access.listPending(envelope.channel)
          await handlers.reply({
            kind: "text",
            text: pending.length
              ? `Pending pairings:\n${pending.map((p) => `- ${p.code} (${p.channel}:${p.externalUserId})`).join("\n")}`
              : "No pending pairing requests.",
            final: true,
          })
          return
        }
        const approved = await input.access.approve(intent.code, `${envelope.channel}:${envelope.externalUserId}`)
        await handlers.reply({
          kind: "text",
          text: approved.ok
            ? `Approved ${approved.channel}:${approved.externalUserId}. They can now message the bot.`
            : approved.message,
          final: true,
        })
        return
      }
      if (intent?.kind === "list_sessions") {
        const sessions = input.listSessions
          ? await input.listSessions({ channel: envelope.channel, externalUserId: envelope.externalUserId })
          : []
        await handlers.reply({
          kind: "text",
          text: sessions.length
            ? `Your sessions:\n${sessions.map((s) => `- ${s.title ?? s.sessionId}${s.appUrl ? ` — ${s.appUrl}` : ""}`).join("\n")}`
            : "No sessions yet. Send a message to start one.",
          final: true,
        })
        return
      }

      const existingRef = await input.sessions.get(envelope.threadKey)

      if (intent?.kind === "status") {
        await handlers.reply({
          kind: "text",
          text: existingRef
            ? `Session ${existingRef.sessionId}${existingRef.appUrl ? ` — ${existingRef.appUrl}` : ""}.`
            : "No active session in this thread. Send a message to start one.",
          final: true,
        })
        return
      }

      if (intent?.kind === "new_session") {
        // Preempt, don't enqueue: OpenClaw #40295 — recovery commands that
        // queue behind a wedged turn never run. Abort any active turn, then
        // drop the binding so the NEXT message opens a fresh session.
        if (existingRef) await input.runtime.abortSession({ sessionId: existingRef.sessionId }).catch(() => undefined)
        await input.resetSession?.(envelope.threadKey)
        await handlers.reply({
          kind: "text",
          text: "Started a fresh session. Your next message begins a new conversation.",
          final: true,
        })
        return
      }

      const action = envelope.intent?.kind === "approval_reply"
        ? "approval"
        : envelope.intent?.kind === "cancel"
          ? "cancel"
          : "message"
      const auth = await input.authorize?.(envelope, { existingSession: existingRef, action })
      if (auth?.ok === false) {
        await handlers.reply({ kind: "text", text: auth.message, final: true })
        return
      }

      // Budget veto — only for message turns (approvals/cancels are cheap and
      // must always land). Refusal replies once with the cap notice.
      if (input.budget && action === "message") {
        const verdict = await input.budget(envelope)
        if (verdict.ok === false) {
          await handlers.reply({ kind: "text", text: verdict.message, final: true })
          return
        }
      }

      const claim = await input.dedup.claim(envelope, {
        reserveSessionCreate: (envelope.intent?.kind ?? "message") === "message" && !existingRef,
      })
      if (claim.ok === false) {
        await handlers.reply({ kind: "text", text: claim.message, final: true })
        return
      }
      if (claim.duplicate) {
        await handlers.reply({
          kind: "status",
          phase: "done",
          ...(claim.sessionId ? { sessionId: claim.sessionId } : {}),
        })
        return
      }

      if (envelope.intent?.kind === "approval_reply") {
        if (!approvals) {
          await handlers.reply({ kind: "text", text: "Approval replies are not enabled for this channel.", final: true })
          return
        }
        const resolved = envelope.intent.callId
          ? { ok: true as const, callId: envelope.intent.callId }
          : envelope.intent.token
            ? await approvals.resolveToken({ token: envelope.intent.token, threadKey: envelope.threadKey })
            : { ok: false as const, message: "Approval reply is missing a prompt token." }
        if (resolved.ok === false) {
          await handlers.reply({ kind: "text", text: resolved.message, final: true })
          return
        }
        const decision = await approvals.decide({
          callId: resolved.callId,
          approved: envelope.intent.approved,
          actorExternalUserId: envelope.externalUserId,
          threadKey: envelope.threadKey,
        })
        await handlers.reply({
          kind: "text",
          text: decision.ok === true ? "Approval recorded." : decision.message,
          final: true,
        })
        return
      }

      if (envelope.intent?.kind === "cancel") {
        if (!existingRef) {
          await handlers.reply({ kind: "text", text: "No active channel session to cancel.", final: true })
          return
        }
        if (envelope.intent.sessionId && envelope.intent.sessionId !== existingRef.sessionId) {
          await handlers.reply({ kind: "text", text: "Session id does not match this channel thread.", final: true })
          return
        }
        const result = await input.runtime.abortSession({ sessionId: existingRef.sessionId })
        await handlers.reply({
          kind: "text",
          text: result.ok ? `Session ${result.status}.` : result.message ?? "Unable to cancel session.",
          final: true,
        })
        return
      }

      const ref = await input.sessions.resolve(envelope).catch(async (error: unknown) => {
        await input.dedup.release(envelope)
        if (error instanceof ChannelSessionResolutionError) return error
        throw error
      })
      if (ref instanceof ChannelSessionResolutionError) {
        await handlers.reply({ kind: "text", text: ref.message, final: true })
        return
      }
      await input.dedup.rememberSession(envelope, ref.sessionId, { sessionCreate: ref.created === true })

      await handlers.reply({
        kind: "status",
        phase: "creating",
        sessionId: ref.sessionId,
        ...(ref.appUrl ? { appUrl: ref.appUrl } : {}),
      })
      if (ref.workspaceId && ref.workspaceRef) {
        await handlers.reply({
          kind: "text",
          text: `Using workspace ${ref.workspaceId} at ${ref.workspaceRef}.`,
          final: false,
        })
      }
      await streamRuntimeReplies({
        sessionId: ref.sessionId,
        threadKey: envelope.threadKey,
        appUrl: ref.appUrl,
        reply: handlers.reply,
        approvals,
        events: input.runtime.sendMessage({
          sessionId: ref.sessionId,
          text: envelope.text,
          channel: envelope.channel,
          externalUserId: envelope.externalUserId,
        }),
      })
    },
    async onApproval(decision) {
      if (!approvals) return { ok: false, message: "Approval bridge is not configured" }
      if (decision.callId) return approvals.decide({ ...decision, callId: decision.callId })
      if (!decision.token) return { ok: false, message: "Approval response is missing a prompt token." }
      const resolved = await approvals.resolveToken({ token: decision.token })
      if (resolved.ok === false) return resolved
      return approvals.decide({ ...decision, callId: resolved.callId })
    },
  }
}
