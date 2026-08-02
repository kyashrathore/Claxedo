import type { ApprovalDecision, ApprovalRequest, ChannelSink, InboundEnvelope, OutboundChunk } from "../envelope"
import type { DedupStore } from "./dedup"
import type { ApprovalBridge } from "./approval-bridge"
import type { ChannelAccess, ChannelDenialReason } from "./access"
import { rateLimitKey, type RateLimiter } from "./rate-limit"
import { streamRuntimeReplies } from "./reply-sink"
import { ChannelSessionResolutionError, type ChannelRuntime, type SessionResolver } from "./resolve-session"
import {
  APPROVAL_UNCLEAR_REPLY,
  runApprovalJudge,
  type ApprovalJudge,
  type ApprovalJudgeTurn,
} from "./approval-judge"

export type ChannelSessionSummary = {
  sessionId: string
  title?: string
  appUrl?: string
  updatedAt?: number
}

export type ChannelCore = {
  handleInbound(input: InboundEnvelope, handlers: { reply: ChannelSink<[OutboundChunk]> }): Promise<void>
  onApproval(input: ApprovalDecision): Promise<{ ok: true } | { ok: false; message: string }>
}

/**
 * Fetch judge history, fail-open to none. A history lookup that errors must
 * still let the judge run on the prompt + reply alone rather than stranding a
 * pending approval.
 */
async function approvalHistory(
  input: {
    approvalHistory?: (context: {
      threadKey: string
      sessionId: string
      request: ApprovalRequest
    }) => Promise<readonly ApprovalJudgeTurn[]>
  },
  envelope: InboundEnvelope,
  request: ApprovalRequest,
) {
  if (!input.approvalHistory) return {}
  const history = await input.approvalHistory({
    threadKey: envelope.threadKey,
    sessionId: request.sessionId,
    request,
  }).catch(() => undefined)
  return history?.length ? { history } : {}
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
  onDenial?: ChannelSink<[InboundEnvelope, ChannelDenialReason | "rate_limited"]>
  /** Gate for in-chat `/pairing approve|list`. Absent → in-chat admin refused. */
  canAdminister?: (envelope: InboundEnvelope) => boolean | Promise<boolean>
  /** Drop the thread→session binding so the next message starts fresh (/new). */
  resetSession?: (threadKey: string) => Promise<void>
  /** List this sender's sessions for /sessions. */
  listSessions?: (input: { channel: string; externalUserId: string }) => Promise<ChannelSessionSummary[]>
  /**
   * Pre-dispatch budget veto — the guardrail between "I approved this sender"
   * and "it spent all night". Checked ONLY for message turns, AFTER
   * access/rate-limit but BEFORE session/LLM. A refusal replies once: a
   * daily-cap notice is useful to an approved sender, unlike a rate-limit
   * reply to a stranger, which would only amplify.
   */
  budget?: (envelope: InboundEnvelope) => Promise<{ ok: true } | { ok: false; message: string }>
  authorize?: (input: InboundEnvelope, context?: {
    existingSession?: Awaited<ReturnType<SessionResolver["get"]>>
    action: "message" | "approval" | "cancel"
  }) => Promise<{ ok: true } | { ok: false; message: string }>
  /**
   * Reads a free-text reply against the pending prompt and returns
   * approved / denied / unclear. Absent → free text never decides an approval;
   * only a button press does, and text reaches the session as an ordinary
   * message. Consulted ONLY while a prompt is pending in the thread.
   */
  judge?: ApprovalJudge
  judgeTimeoutMs?: number
  /**
   * Prior turns for the judge, so it can resolve a reply that only makes sense
   * in context ("do the first one", "not that one"). Absent → the judge sees
   * the prompt and the reply alone.
   */
  approvalHistory?: (input: {
    threadKey: string
    sessionId: string
    request: ApprovalRequest
  }) => Promise<readonly ApprovalJudgeTurn[]>
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
      //    Deliberately NOT passed `envelope.receivedAt`: that is the sender's
      //    CLAIMED time, copied straight out of the provider webhook payload,
      //    and the sliding window ages hits out relative to whatever it is
      //    given — so one forged future timestamp would empty the bucket and
      //    hand the flooder a fresh budget. The window must advance on the
      //    server clock only.
      if (input.rateLimiter && !envelope.trustedSource) {
        const rl = input.rateLimiter.check(rateLimitKey(envelope.channel, envelope.externalUserId))
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
        // Preempt, don't enqueue: a recovery command that queues behind a
        // wedged turn never runs. Abort any active turn, then drop the binding
        // so the NEXT message opens a fresh session.
        if (existingRef) await input.runtime.abortSession({ sessionId: existingRef.sessionId }).catch(() => undefined)
        await input.resetSession?.(envelope.threadKey)
        await handlers.reply({
          kind: "text",
          text: "Started a fresh session. Your next message begins a new conversation.",
          final: true,
        })
        return
      }

      // A plain message arriving while a prompt is pending in this thread is a
      // candidate approval reply — the judge decides below whether it actually
      // is one. Resolved HERE so it can classify the turn as an approval for
      // `authorize` and the budget veto, exactly like a button press.
      const pendingApproval = input.judge && approvals && (envelope.intent?.kind ?? "message") === "message"
        ? (await approvals.pendingForThread(envelope.threadKey).catch(() => []))[0]
        : undefined

      const action = envelope.intent?.kind === "approval_reply" || pendingApproval
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
        reserveSessionCreate: (envelope.intent?.kind ?? "message") === "message" && !pendingApproval && !existingRef,
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

      // STRUCTURED approval — a button press, carrying the token or call id it
      // was rendered with. No interpretation needed.
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

      // JUDGED approval — free text arriving while a prompt is pending. The
      // judge reads it in the context of the prompt and the conversation and
      // says yes / no / unclear. Unclear re-asks rather than guessing: a wrong
      // "yes" executes something irreversible, a re-ask costs one message.
      if (pendingApproval && input.judge && approvals) {
        const verdict = await runApprovalJudge({
          judge: input.judge,
          request: pendingApproval,
          text: envelope.text,
          ...(await approvalHistory(input, envelope, pendingApproval)),
          ...(input.judgeTimeoutMs === undefined ? {} : { timeoutMs: input.judgeTimeoutMs }),
        })
        if (verdict.decision === "unclear") {
          await handlers.reply({
            kind: "text",
            text: verdict.question ?? APPROVAL_UNCLEAR_REPLY,
            final: true,
          })
          return
        }
        const decision = await approvals.decide({
          callId: pendingApproval.callId,
          approved: verdict.decision === "approved",
          actorExternalUserId: envelope.externalUserId,
          threadKey: envelope.threadKey,
        })
        await handlers.reply({
          kind: "text",
          text: decision.ok === true
            ? verdict.decision === "approved" ? "Approved." : "Denied."
            : decision.message,
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
        requestee: envelope.externalUserId,
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
      // The decision's threadKey (set by the transport from the thread the
      // button was clicked in) rides all the way through to `decide` and
      // `resolveToken`, which is what makes their thread checks real. Dropping
      // it here — as this used to — left those guards comparing against
      // undefined, so a press from any thread resolved any pending prompt.
      if (decision.callId) return approvals.decide({ ...decision, callId: decision.callId })
      if (!decision.token) return { ok: false, message: "Approval response is missing a prompt token." }
      const resolved = await approvals.resolveToken({
        token: decision.token,
        ...(decision.threadKey ? { threadKey: decision.threadKey } : {}),
      })
      if (resolved.ok === false) return resolved
      return approvals.decide({ ...decision, callId: resolved.callId })
    },
  }
}
