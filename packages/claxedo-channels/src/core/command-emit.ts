import { channelFromThreadKey } from "../envelope"
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

/**
 * Property syntax, not methods: neither implementation uses `this`, and every
 * caller passes these around as plain functions (transports hand them to SDK
 * handlers, tests assert on the mock). Declaring them as methods made every
 * such reference an unbound-method hazard for no gain.
 */
export type ChannelCore = {
  handleInbound: (input: InboundEnvelope, handlers: { reply: ChannelSink<[OutboundChunk]> }) => Promise<void>
  onApproval: (input: ApprovalDecision) => Promise<{ ok: true } | { ok: false; message: string }>
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
  authorize?: (
    input: InboundEnvelope,
    context?: {
      existingSession?: Awaited<ReturnType<SessionResolver["get"]>>
      action: "message" | "approval" | "cancel" | "status"
    },
  ) => Promise<{ ok: true } | { ok: false; message: string }>
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

  /**
   * The sender gate every turn clears — an inbound message and a button press
   * alike — returning the refusal reason, or undefined once the sender is
   * admitted. Both callers run it: a gate written out a second time for the
   * press path is a gate that can drift out from under it.
   *
   * Access runs before any other work (dedup/session/LLM): forwarding to the
   * agent first leaks private content however correct the policy is. A refused
   * stranger costs at most one throttled pairing reply; every other denial goes
   * to the owner audit rather than back to the sender, so neither gate can be
   * turned into an outbound amplifier. Trusted local injection (the loopback
   * fake transport) bypasses both.
   */
  async function admitSender(
    envelope: InboundEnvelope,
    handlers: Parameters<ChannelCore["handleInbound"]>[1],
  ): Promise<ChannelDenialReason | "rate_limited" | undefined> {
    if (input.access && !envelope.trustedSource) {
      const decision = await input.access.gate(envelope)
      if (decision.admission === "drop") {
        await input.onDenial?.(envelope, decision.reason)
        if (decision.reply) await handlers.reply({ kind: "text", text: decision.reply, final: true })
        return decision.reason
      }
    }

    // The limiter is deliberately NOT passed `envelope.receivedAt`: that is the
    // sender's CLAIMED time, copied straight out of the provider webhook
    // payload, and the sliding window ages hits out relative to whatever it is
    // given — so one forged future timestamp would empty the bucket and hand
    // the flooder a fresh budget. The window must advance on the server clock
    // only.
    if (input.rateLimiter && !envelope.trustedSource) {
      const rl = input.rateLimiter.check(rateLimitKey(envelope.channel, envelope.externalUserId))
      if (!rl.allowed) {
        await input.onDenial?.(envelope, "rate_limited")
        return "rate_limited"
      }
    }
    return undefined
  }

  /**
   * Resolve an approval to the prompt it answers and record it.
   *
   * A refusal releases the dedup claim so the same delivery can be answered
   * again once whatever refused it is corrected; a recorded decision keeps the
   * claim, which is what makes a redelivery inert. Both approval paths run
   * through here, so a press and a structured reply cannot diverge on which of
   * the two a given outcome gets.
   */
  async function recordApproval(envelope: InboundEnvelope, decision: {
    callId?: string
    token?: string
    approved: boolean
    actorExternalUserId: string
    threadKey?: string
  }): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!approvals) return { ok: false, message: "Approval replies are not enabled for this channel." }
    // The thread the answer came from rides all the way through to
    // `resolveToken` and `decide`, which is what makes their thread checks
    // real. Drop it and those guards compare against undefined, letting an
    // answer from any thread resolve any pending prompt.
    const thread = decision.threadKey ? { threadKey: decision.threadKey } : {}
    try {
      const resolved = decision.callId
        ? { ok: true as const, callId: decision.callId }
        : decision.token
          ? await approvals.resolveToken({ token: decision.token, ...thread })
          : { ok: false as const, message: "Approval reply is missing a prompt token." }
      const result = resolved.ok
        ? await approvals.decide({
          callId: resolved.callId,
          approved: decision.approved,
          actorExternalUserId: decision.actorExternalUserId,
          ...thread,
        })
        : resolved
      if (!result.ok) await input.dedup.release(envelope).catch(() => {})
      return result
    } catch (error) {
      await input.dedup.release(envelope).catch(() => {})
      throw error
    }
  }

  async function handleSessionlessCommand(
    envelope: InboundEnvelope,
    handlers: Parameters<ChannelCore["handleInbound"]>[1],
  ) {
    const intent = envelope.intent
    if (intent?.kind === "whoami") {
      await handlers.reply({
        kind: "text",
        text: `Your sender id is ${envelope.channel}:${envelope.externalUserId}. An owner allowlists this exact id.`,
        final: true,
      })
      return true
    }
    if (intent?.kind === "pairing_list" || intent?.kind === "pairing_approve") {
      const isAdmin = input.canAdminister ? await input.canAdminister(envelope) : false
      if (!isAdmin || !input.access) {
        await handlers.reply({
          kind: "text",
          text: "Pairing administration is not available from this chat.",
          final: true,
        })
        return true
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
        return true
      }
      const approved = await input.access.approve(intent.code, `${envelope.channel}:${envelope.externalUserId}`)
      await handlers.reply({
        kind: "text",
        text: approved.ok
          ? `Approved ${approved.channel}:${approved.externalUserId}. They can now message the bot.`
          : approved.message,
        final: true,
      })
      return true
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
      return true
    }
    return false
  }

  async function handleSessionCommand(
    envelope: InboundEnvelope,
    handlers: Parameters<ChannelCore["handleInbound"]>[1],
    existingRef: Awaited<ReturnType<SessionResolver["get"]>>,
  ) {
    const intent = envelope.intent
    if (intent?.kind === "status") {
      await handlers.reply({
        kind: "text",
        text: existingRef
          ? `Session ${existingRef.sessionId}${existingRef.appUrl ? ` — ${existingRef.appUrl}` : ""}.`
          : "No active session in this thread. Send a message to start one.",
        final: true,
      })
      return true
    }

    if (intent?.kind === "new_session") {
      // Preempt, don't enqueue: a recovery command that queues behind a
      // wedged turn never runs. Abort any active turn, then drop the binding
      // so the NEXT message opens a fresh session.
      if (existingRef) {
        const stopped = await input.runtime.abortSession({
          sessionId: existingRef.sessionId, channel: envelope.channel,
          externalUserId: envelope.externalUserId, threadKey: envelope.threadKey,
        }).catch(() => ({ ok: false, message: "Unable to cancel the existing session. Its binding was preserved." }))
        if (!stopped.ok) {
          await handlers.reply({ kind: "text", text: stopped.message ?? "Unable to cancel the existing session. Its binding was preserved.", final: true })
          return true
        }
      }
      await input.resetSession?.(envelope.threadKey)
      await handlers.reply({
        kind: "text",
        text: "Started a fresh session. Your next message begins a new conversation.",
        final: true,
      })
      return true
    }
    return false
  }

  async function handleStructuredApproval(
    envelope: InboundEnvelope,
    handlers: Parameters<ChannelCore["handleInbound"]>[1],
  ) {
    // STRUCTURED approval — a reply carrying the token or call id the prompt
    // was rendered with. No interpretation needed.
    const intent = envelope.intent
    if (intent?.kind !== "approval_reply") return false
    const result = await recordApproval(envelope, {
      ...(intent.callId ? { callId: intent.callId } : {}),
      ...(intent.token ? { token: intent.token } : {}),
      approved: intent.approved,
      actorExternalUserId: envelope.externalUserId,
      threadKey: envelope.threadKey,
    })
    await handlers.reply({
      kind: "text",
      text: result.ok ? "Approval recorded." : result.message,
      final: true,
    })
    return true
  }

  async function handleJudgedApproval(
    envelope: InboundEnvelope,
    handlers: Parameters<ChannelCore["handleInbound"]>[1],
    pendingApproval: ApprovalRequest | undefined,
  ) {
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
        return true
      }
      const decision = await approvals.decide({
        callId: pendingApproval.callId,
        approved: verdict.decision === "approved",
        actorExternalUserId: envelope.externalUserId,
        threadKey: envelope.threadKey,
      })
      await handlers.reply({
        kind: "text",
        text:  decision.ok ? (verdict.decision === "approved" ? "Approved." : "Denied.") : decision.message,
        final: true,
      })
      return true
    }
    return false
  }

  async function handleCancel(
    envelope: InboundEnvelope,
    handlers: Parameters<ChannelCore["handleInbound"]>[1],
    existingRef: Awaited<ReturnType<SessionResolver["get"]>>,
  ) {
    if (envelope.intent?.kind === "cancel") {
      if (!existingRef) {
        await handlers.reply({ kind: "text", text: "No active channel session to cancel.", final: true })
        return true
      }
      if (envelope.intent.sessionId && envelope.intent.sessionId !== existingRef.sessionId) {
        await handlers.reply({ kind: "text", text: "Session id does not match this channel thread.", final: true })
        return true
      }
      const result = await input.runtime.abortSession({ sessionId: existingRef.sessionId, channel: envelope.channel, externalUserId: envelope.externalUserId, threadKey: envelope.threadKey })
      await handlers.reply({
        kind: "text",
        text: result.ok ? `Session ${result.status}.` : (result.message ?? "Unable to cancel session."),
        final: true,
      })
      return true
    }
    return false
  }

  async function dispatchMessage(envelope: InboundEnvelope, handlers: Parameters<ChannelCore["handleInbound"]>[1]) {
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
        threadKey: envelope.threadKey,
        channel: envelope.channel,
        externalUserId: envelope.externalUserId,
      }),
    })
  }

  return {
    async handleInbound(envelope, handlers) {
      if (await admitSender(envelope, handlers)) return

      if (await handleSessionlessCommand(envelope, handlers)) return

      const existingRef = await input.sessions.get(envelope.threadKey)

      // A plain message arriving while a prompt is pending in this thread is a
      // candidate approval reply — the judge decides below whether it actually
      // is one. Resolved HERE so it can classify the turn as an approval for
      // `authorize` and the budget veto, exactly like a button press.
      const pendingApproval =
        input.judge && approvals && (envelope.intent?.kind ?? "message") === "message"
          ? (await approvals.pendingForThread(envelope.threadKey).catch(() => []))[0]
          : undefined

      const action =
        envelope.intent?.kind === "approval_reply" || pendingApproval
          ? "approval"
          : envelope.intent?.kind === "cancel" || envelope.intent?.kind === "new_session"
            ? "cancel"
            : envelope.intent?.kind === "status"
              ? "status"
            : "message"
      const auth = await input.authorize?.(envelope, { existingSession: existingRef, action })
      if (auth?.ok === false) {
        await handlers.reply({ kind: "text", text: auth.message, final: true })
        return
      }

      if (await handleSessionCommand(envelope, handlers, existingRef)) return

      // Budget veto — only for message turns (approvals/cancels are cheap and
      // must always land). Refusal replies once with the cap notice.
      if (input.budget && action === "message") {
        const verdict = await input.budget(envelope)
        if (!verdict.ok) {
          await handlers.reply({ kind: "text", text: verdict.message, final: true })
          return
        }
      }

      const claim = await input.dedup.claim(envelope, {
        reserveSessionCreate: (envelope.intent?.kind ?? "message") === "message" && !pendingApproval && !existingRef,
      })
      if (!claim.ok) {
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

      if (await handleStructuredApproval(envelope, handlers)) return

      if (await handleJudgedApproval(envelope, handlers, pendingApproval)) return

      if (await handleCancel(envelope, handlers, existingRef)) return

      await dispatchMessage(envelope, handlers)
    },
    async onApproval(decision) {
      // A button press is a webhook delivery like any inbound message, so it
      // clears the same gates through the same code: `admitSender`, then
      // authorization, dedup and `recordApproval`. A decision that can name no
      // channel cannot be attributed to any of those gates, so it is refused
      // rather than let through unchecked.
      const channel = decision.channel ?? channelFromThreadKey(decision.threadKey)
      if (!channel) {
        return { ok: false, message: "Approval action could not be attributed to a channel." }
      }
      const envelope: InboundEnvelope = {
        channel,
        externalUserId: decision.actorExternalUserId,
        threadKey: decision.threadKey ?? `${channel}:unknown`,
        idempotencyKey: `approval:${decision.actorExternalUserId}:${decision.messageId ?? decision.callId ?? decision.token ?? "unknown"}`,
        text: "",
        chatType: decision.chatType ?? "dm",
        // Pressing a button on the bot's own card IS addressing the bot —
        // without the marker a "mention"-mode group would read the press as
        // unaddressed chatter and drop it.
        mentions: ["@bot"],
        intent: {
          kind: "approval_reply",
          approved: decision.approved,
          ...(decision.callId ? { callId: decision.callId } : {}),
          ...(decision.token ? { token: decision.token } : {}),
        },
        raw: decision,
      }
      // A press arrives with no reply sink, so the throttled pairing offer the
      // gate hands an inbound message is discarded rather than posted.
      const refused = await admitSender(envelope, { reply: async () => {} })
      if (refused) {
        return {
          ok: false,
          message: refused === "rate_limited"
            ? "Rate limit exceeded."
            : "This sender is not permitted to answer approvals.",
        }
      }
      const existingRef = decision.threadKey ? await input.sessions.get(decision.threadKey) : undefined
      const auth = await input.authorize?.(envelope, {
        ...(existingRef ? { existingSession: existingRef } : {}),
        action: "approval",
      })
      if (auth?.ok === false) return { ok: false, message: auth.message }
      const claim = await input.dedup.claim(envelope)
      if (!claim.ok) return { ok: false, message: claim.message }
      if (claim.duplicate) return { ok: false, message: "This approval action was already processed." }
      return recordApproval(envelope, {
        ...(decision.callId ? { callId: decision.callId } : {}),
        ...(decision.token ? { token: decision.token } : {}),
        approved: decision.approved,
        actorExternalUserId: decision.actorExternalUserId,
        ...(decision.threadKey ? { threadKey: decision.threadKey } : {}),
      })
    },
  }
}
