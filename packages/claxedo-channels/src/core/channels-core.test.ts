import { describe, expect, test } from "vitest"
import {
  createChannelCore,
  createMemoryApprovalBridge,
  createMemoryDedupStore,
  createMemorySessionResolver,
  ChannelSessionResolutionError,
  parseChannelCommand,
  APPROVAL_UNCLEAR_REPLY,
  type ApprovalJudge,
  type ApprovalJudgeTurn,
  type ApprovalJudgeVerdict,
  type ChannelRuntime,
  type InboundEnvelope,
  type OutboundChunk,
} from "../index"

function envelope(input: Partial<InboundEnvelope> = {}): InboundEnvelope {
  return {
    channel: "telegram",
    externalUserId: "owner",
    threadKey: "telegram:install:chat:thread",
    idempotencyKey: "delivery-1",
    text: "hello",
    receivedAt: Date.now(),
    raw: {},
    ...input,
  }
}

function runtime(): ChannelRuntime & { created: string[]; sent: string[]; aborted: string[] } {
  const created: string[] = []
  const sent: string[] = []
  const aborted: string[] = []
  return {
    created,
    sent,
    aborted,
    async createSession(input) {
      const sessionId = `ses_${created.length + 1}`
      created.push(`${input.channel}:${input.threadKey}`)
      return { sessionId, appUrl: `/s/${sessionId}` }
    },
    async *sendMessage(input) {
      sent.push(`${input.sessionId}:${input.text}`)
      if (input.text === "needs approval") {
        yield {
          type: "permission.asked",
          properties: {
            id: `${input.sessionId}:perm_1`,
            sessionID: input.sessionId,
            tool: "bash",
            title: "Run command",
          },
        }
      }
      // The shape the runtime actually emits: classification in `permission`,
      // human-readable title nested under `metadata`.
      if (input.text === "acp permission") {
        yield {
          type: "permission.asked",
          properties: {
            id: `${input.sessionId}:perm_1`,
            sessionID: input.sessionId,
            permission: "execute",
            patterns: ["migrations/001.sql"],
            metadata: { title: "Run the database migration" },
          },
        }
      }
      if (input.text === "acp permission untitled") {
        yield {
          type: "permission.asked",
          properties: {
            id: `${input.sessionId}:perm_1`,
            sessionID: input.sessionId,
            permission: "edit",
            patterns: ["src/index.ts", "src/app.ts"],
          },
        }
      }
      yield { type: "text-delta", delta: `echo:${input.text}` }
      if (input.text === "part update") {
        yield {
          type: "message.part.updated",
          properties: { part: { type: "text", text: "part text" } },
        }
      }
      yield { type: "finish", sessionId: input.sessionId }
    },
    async abortSession(input) {
      aborted.push(input.sessionId)
      return { ok: true, status: "cancelled" }
    },
  }
}

async function handle(input: InboundEnvelope, rt = runtime()) {
  const chunks: OutboundChunk[] = []
  const core = createChannelCore({
    runtime: rt,
    dedup: createMemoryDedupStore({ initializedAt: 0 }),
    sessions: createMemorySessionResolver(rt),
    approvals: createMemoryApprovalBridge(),
    authorize: async () => ({ ok: true }),
  })
  await core.handleInbound(input, {
    reply(chunk) {
      chunks.push(chunk)
    },
  })
  return { chunks, rt, core }
}

describe("channels core", () => {
  test("creates a session, sends the message, and returns ordered chunks ending final", async () => {
    const result = await handle(envelope())

    expect(result.rt.created).toEqual(["telegram:telegram:install:chat:thread"])
    expect(result.rt.sent).toEqual(["ses_1:hello"])
    expect(result.chunks.map((chunk) => chunk.kind)).toEqual(["status", "status", "text", "status", "text"])
    expect(result.chunks.at(-1)).toMatchObject({ kind: "text", final: true })
  })

  test("session-creating replies carry app deep links through status and final chunks", async () => {
    const result = await handle(envelope())

    expect(result.chunks).toEqual(expect.arrayContaining([
      { kind: "status", phase: "creating", sessionId: "ses_1", appUrl: "/s/ses_1" },
      { kind: "status", phase: "running", sessionId: "ses_1", appUrl: "/s/ses_1" },
      { kind: "status", phase: "done", sessionId: "ses_1", appUrl: "/s/ses_1" },
      { kind: "text", text: "Open: /s/ses_1", final: true },
    ]))
  })

  test("deduplicates repeated idempotency keys without creating a second run", async () => {
    const rt = runtime()
    const chunks: OutboundChunk[] = []
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
    })

    await core.handleInbound(envelope(), { reply: (chunk) => chunks.push(chunk) })
    await core.handleInbound(envelope(), { reply: (chunk) => chunks.push(chunk) })

    expect(rt.created).toHaveLength(1)
    expect(rt.sent).toHaveLength(1)
    expect(chunks.at(-1)).toMatchObject({ kind: "status", phase: "done", sessionId: "ses_1" })
  })

  test("streams text from central message part updates", async () => {
    const result = await handle(envelope({ text: "part update" }))

    expect(result.chunks).toContainEqual({ kind: "text", text: "part text", final: false })
  })

  test("rejects stale deliveries before idempotency lookup", async () => {
    const dedup = createMemoryDedupStore({ initializedAt: 1_000_000, replayWindows: { telegram: 1000 } })

    await expect(dedup.claim(envelope({ receivedAt: 998_000 }), { now: 1_000_000 })).resolves.toMatchObject({
      ok: false,
      reason: "stale_delivery",
    })
  })

  test("rejects deliveries timestamped before store initialization even inside the replay window", async () => {
    const dedup = createMemoryDedupStore({ initializedAt: 1_000_000, replayWindows: { telegram: 10_000 } })

    await expect(dedup.claim(envelope({ receivedAt: 999_999 }), { now: 1_000_001 })).resolves.toMatchObject({
      ok: false,
      reason: "stale_delivery",
    })
  })

  test("daily ceiling reserves session creates without counting continuing messages", async () => {
    const dedup = createMemoryDedupStore({ initializedAt: 0, dailyCeiling: 1 })
    const first = envelope({ idempotencyKey: "delivery-1" })

    await expect(dedup.claim(first, { now: 1_000_000, reserveSessionCreate: true })).resolves.toEqual({
      ok: true,
      duplicate: false,
    })
    await expect(dedup.countByChannelUserDay({
      channel: "telegram",
      externalUserId: "owner",
      day: "1970-01-01",
    })).resolves.toBe(1)

    await dedup.rememberSession(first, "ses_1")
    await expect(dedup.claim(envelope({ idempotencyKey: "delivery-2" }), { now: 1_000_001 })).resolves.toEqual({
      ok: true,
      duplicate: false,
    })

    await expect(dedup.countByChannelUserDay({
      channel: "telegram",
      externalUserId: "owner",
      day: "1970-01-01",
    })).resolves.toBe(1)
    await expect(dedup.claim(envelope({ idempotencyKey: "delivery-3" }), {
      now: 1_000_002,
      reserveSessionCreate: true,
    })).resolves.toMatchObject({
      ok: false,
      reason: "daily_ceiling_exceeded",
    })
  })

  test("keeps identical platform thread ids isolated by namespaced threadKey", async () => {
    const rt = runtime()
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
    })

    await core.handleInbound(envelope({ threadKey: "github:install-a:issue-1:root", idempotencyKey: "a" }), { reply: () => {} })
    await core.handleInbound(envelope({ threadKey: "github:install-b:issue-1:root", idempotencyKey: "b" }), { reply: () => {} })

    expect(rt.created).toEqual([
      "telegram:github:install-a:issue-1:root",
      "telegram:github:install-b:issue-1:root",
    ])
  })

  test("cancel intent aborts the resolved channel session", async () => {
    const rt = runtime()
    const chunks: OutboundChunk[] = []
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
    })

    await core.handleInbound(envelope(), { reply: () => {} })
    await core.handleInbound(envelope({
      idempotencyKey: "delivery-2",
      intent: { kind: "cancel" },
    }), { reply: (chunk) => chunks.push(chunk) })

    expect(rt.aborted).toEqual(["ses_1"])
    expect(chunks.at(-1)).toMatchObject({ kind: "text", text: "Session cancelled.", final: true })
  })

  test("cancel intent without an active thread session does not create a session", async () => {
    const rt = runtime()
    const chunks: OutboundChunk[] = []
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
    })

    await core.handleInbound(envelope({
      text: "/stop",
      intent: { kind: "cancel" },
    }), { reply: (chunk) => chunks.push(chunk) })

    expect(rt.created).toEqual([])
    expect(rt.aborted).toEqual([])
    expect(chunks).toEqual([{ kind: "text", text: "No active channel session to cancel.", final: true }])
  })

  test("cancel intent can target the active thread session explicitly", async () => {
    const rt = runtime()
    const chunks: OutboundChunk[] = []
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
    })

    await core.handleInbound(envelope(), { reply: () => {} })
    await core.handleInbound(envelope({
      idempotencyKey: "delivery-2",
      text: "/stop ses_1",
      intent: { kind: "cancel", sessionId: "ses_1" },
    }), { reply: (chunk) => chunks.push(chunk) })

    expect(rt.created).toEqual(["telegram:telegram:install:chat:thread"])
    expect(rt.aborted).toEqual(["ses_1"])
    expect(chunks.at(-1)).toMatchObject({ kind: "text", text: "Session cancelled.", final: true })
  })

  test("cancel intent rejects explicit session ids from another thread", async () => {
    const rt = runtime()
    const chunks: OutboundChunk[] = []
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
    })

    await core.handleInbound(envelope(), { reply: () => {} })
    await core.handleInbound(envelope({
      idempotencyKey: "delivery-2",
      text: "/stop ses_external",
      intent: { kind: "cancel", sessionId: "ses_external" },
    }), { reply: (chunk) => chunks.push(chunk) })

    expect(rt.aborted).toEqual([])
    expect(chunks.at(-1)).toMatchObject({ kind: "text", text: "Session id does not match this channel thread.", final: true })
  })

  test("parses explicit stop session ids without treating free text as a target session", () => {
    expect(parseChannelCommand("/stop ses_external-1")).toEqual({
      kind: "cancel",
      sessionId: "ses_external-1",
    })
    expect(parseChannelCommand("/stop please")).toEqual({ kind: "cancel" })
  })

  test("authorization rejection does not claim idempotency or create a session", async () => {
    const rt = runtime()
    const chunks: OutboundChunk[] = []
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
      authorize: async () => ({ ok: false, message: "Link your account first." }),
    })

    await core.handleInbound(envelope(), { reply: (chunk) => chunks.push(chunk) })

    expect(rt.created).toEqual([])
    expect(chunks).toEqual([{ kind: "text", text: "Link your account first.", final: true }])
  })

  test("session resolution failures reply without sending a message", async () => {
    const rt = runtime()
    const chunks: OutboundChunk[] = []
    const core = createChannelCore({
      runtime: {
        ...rt,
        async createSession() {
          throw new ChannelSessionResolutionError("No registered workspace for acme/repo.")
        },
      },
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver({
        ...rt,
        async createSession() {
          throw new ChannelSessionResolutionError("No registered workspace for acme/repo.")
        },
      }),
    })

    await core.handleInbound(envelope({
      channel: "github",
      repo: { owner: "acme", name: "repo" },
    }), { reply: (chunk) => chunks.push(chunk) })

    expect(rt.sent).toEqual([])
    expect(chunks).toEqual([{ kind: "text", text: "No registered workspace for acme/repo.", final: true }])
  })

  test("session resolution failures release idempotency for a later retry", async () => {
    const rt = runtime()
    const chunks: OutboundChunk[] = []
    let failures = 1
    const resolver = createMemorySessionResolver({
      ...rt,
      async createSession(input) {
        if (failures > 0) {
          failures -= 1
          throw new ChannelSessionResolutionError("Workspace is temporarily unavailable.")
        }
        return rt.createSession(input)
      },
    })
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: resolver,
    })

    await core.handleInbound(envelope(), { reply: (chunk) => chunks.push(chunk) })
    await core.handleInbound(envelope(), { reply: (chunk) => chunks.push(chunk) })

    expect(rt.created).toEqual(["telegram:telegram:install:chat:thread"])
    expect(rt.sent).toEqual(["ses_1:hello"])
    expect(chunks).toContainEqual({ kind: "text", text: "Workspace is temporarily unavailable.", final: true })
  })

  test("repo-bound sessions state the registered workspace ref", async () => {
    const rt = runtime()
    const chunks: OutboundChunk[] = []
    const core = createChannelCore({
      runtime: {
        ...rt,
        async createSession(input) {
          const session = await rt.createSession(input)
          return { ...session, workspaceRef: "branch dev" }
        },
      },
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver({
        ...rt,
        async createSession(input) {
          const session = await rt.createSession(input)
          return { ...session, workspaceRef: "branch dev" }
        },
      }),
    })

    await core.handleInbound(envelope({
      channel: "github",
      repo: { owner: "acme", name: "repo" },
    }), { reply: (chunk) => chunks.push(chunk) })

    expect(chunks).toContainEqual({ kind: "text", text: "Using workspace acme/repo at branch dev.", final: false })
  })

  test("repo targets from chat transports bind non-GitHub sessions to workspaces", async () => {
    const rt = runtime()
    const core = createChannelCore({
      runtime: {
        ...rt,
        async createSession(input) {
          expect(input).toMatchObject({
            channel: "telegram",
            workspaceId: "acme/tools",
          })
          const session = await rt.createSession(input)
          return { ...session, workspaceRef: "branch feature" }
        },
      },
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver({
        ...rt,
        async createSession(input) {
          expect(input).toMatchObject({
            channel: "telegram",
            workspaceId: "acme/tools",
          })
          const session = await rt.createSession(input)
          return { ...session, workspaceRef: "branch feature" }
        },
      }),
    })
    const chunks: OutboundChunk[] = []

    await core.handleInbound(envelope({
      repo: { owner: "acme", name: "tools" },
      text: "repo:acme/tools fix the failing test",
    }), { reply: (chunk) => chunks.push(chunk) })

    expect(chunks).toContainEqual({
      kind: "text",
      text: "Using workspace acme/tools at branch feature.",
      final: false,
    })
  })

  test("permission events become tokenized approval prompts and numbered replies bind by token", async () => {
    const decisions: string[] = []
    const rt = runtime()
    const chunks: OutboundChunk[] = []
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
      approvals: createMemoryApprovalBridge({
        async onDecision(_request, decision) {
          decisions.push(`${decision.callId}:${decision.approved}`)
          return { ok: true }
        },
      }),
    })

    await core.handleInbound(envelope({ text: "needs approval" }), { reply: (chunk) => chunks.push(chunk) })
    const approval = chunks.find((chunk): chunk is Extract<OutboundChunk, { kind: "approval" }> => chunk.kind === "approval")
    expect(approval?.request.token).toMatch(/^[a-f0-9]{16}$/)
    await core.handleInbound(envelope({
      idempotencyKey: "approval-1",
      text: `approve ${approval!.request.token}`,
      intent: { kind: "approval_reply", approved: true, token: approval!.request.token },
    }), { reply: (chunk) => chunks.push(chunk) })

    expect(chunks).toContainEqual({
      kind: "approval",
      request: {
        callId: "ses_1:perm_1",
        sessionId: "ses_1",
        threadKey: "telegram:install:chat:thread",
        summary: "Run command",
        tool: "bash",
        token: approval?.request.token,
        // The sender whose turn raised the prompt; only their answer counts.
        requestee: "owner",
      },
    })
    expect(decisions).toEqual(["ses_1:perm_1:true"])
    expect(chunks.at(-1)).toEqual({ kind: "text", text: "Approval recorded.", final: true })
  })

  test("approval action callbacks can bind pending prompts by token", async () => {
    const decisions: string[] = []
    const rt = runtime()
    const chunks: OutboundChunk[] = []
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
      approvals: createMemoryApprovalBridge({
        async onDecision(_request, decision) {
          decisions.push(`${decision.callId}:${decision.approved}:${decision.actorExternalUserId}`)
          return { ok: true }
        },
      }),
    })

    await core.handleInbound(envelope({ text: "needs approval" }), { reply: (chunk) => chunks.push(chunk) })
    const approval = chunks.find((chunk): chunk is Extract<OutboundChunk, { kind: "approval" }> => chunk.kind === "approval")
    expect(approval?.request.token).toMatch(/^[a-f0-9]{16}$/)
    // The actor is the sender the prompt was issued to; a different actor is
    // covered by the requestee tests below.
    await expect(core.onApproval({
      token: approval!.request.token,
      approved: false,
      actorExternalUserId: "owner",
    })).resolves.toEqual({ ok: true })

    expect(decisions).toEqual(["ses_1:perm_1:false:owner"])
  })

  test("unknown approval tokens are rejected without creating a session", async () => {
    const rt = runtime()
    const chunks: OutboundChunk[] = []
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
      approvals: createMemoryApprovalBridge(),
    })

    await core.handleInbound(envelope({
      text: "approve missing",
      intent: { kind: "approval_reply", approved: true, token: "missing" },
    }), { reply: (chunk) => chunks.push(chunk) })

    expect(rt.created).toEqual([])
    expect(chunks).toEqual([{ kind: "text", text: "Approval reply did not match a pending prompt.", final: true }])
  })
})

describe("requestee-only button approvals", () => {
  // A card posted in a group is visible to everyone in the room and its buttons
  // are pressable by all of them, so the prompt records WHO it is waiting on and
  // the bridge checks the actor against it.
  async function pendingPrompt() {
    const rt = runtime()
    const decisions: string[] = []
    const chunks: OutboundChunk[] = []
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
      approvals: createMemoryApprovalBridge({
        async onDecision(_request, decision) {
          decisions.push(`${decision.callId}:${decision.approved}:${decision.actorExternalUserId}`)
          return { ok: true }
        },
      }),
    })
    // "asker" raises the turn, so "asker" is the requestee.
    await core.handleInbound(
      envelope({ externalUserId: "asker", text: "needs approval", chatType: "group", mentions: ["@claxedo"] }),
      { reply: (chunk) => chunks.push(chunk) },
    )
    const approval = chunks.find((chunk): chunk is Extract<OutboundChunk, { kind: "approval" }> => chunk.kind === "approval")
    return { core, decisions, request: approval!.request }
  }

  test("records the sender whose turn raised the prompt as the requestee", async () => {
    const { request } = await pendingPrompt()
    expect(request.requestee).toBe("asker")
    expect(request.threadKey).toBe("telegram:install:chat:thread")
  })

  test("the requestee's press is accepted", async () => {
    const { core, decisions, request } = await pendingPrompt()

    await expect(core.onApproval({
      token: request.token,
      approved: true,
      actorExternalUserId: "asker",
      threadKey: request.threadKey,
    })).resolves.toEqual({ ok: true })

    expect(decisions).toEqual(["ses_1:perm_1:true:asker"])
  })

  test("an onlooker's press is rejected and leaves the prompt pending", async () => {
    const { core, decisions, request } = await pendingPrompt()

    await expect(core.onApproval({
      token: request.token,
      approved: true,
      actorExternalUserId: "bystander",
      threadKey: request.threadKey,
    })).resolves.toMatchObject({ ok: false })

    // Not merely unrecorded — still answerable by the person actually asked.
    expect(decisions).toEqual([])
    await expect(core.onApproval({
      token: request.token,
      approved: false,
      actorExternalUserId: "asker",
      threadKey: request.threadKey,
    })).resolves.toEqual({ ok: true })
    expect(decisions).toEqual(["ses_1:perm_1:false:asker"])
  })

  test("a press from another thread is rejected even by the requestee", async () => {
    // The threadKey now travels with button decisions, so this guard is live.
    // Before it did, a press in any thread resolved any pending prompt.
    const { core, decisions, request } = await pendingPrompt()

    await expect(core.onApproval({
      token: request.token,
      approved: true,
      actorExternalUserId: "asker",
      threadKey: "telegram:install:other-chat:other-thread",
    })).resolves.toMatchObject({ ok: false })

    expect(decisions).toEqual([])
  })

})

describe("judged approvals", () => {
  function judgedCore(input: {
    judge: ApprovalJudge
    decisions: string[]
    approvalHistory?: Parameters<typeof createChannelCore>[0]["approvalHistory"]
  }) {
    const rt = runtime()
    const chunks: OutboundChunk[] = []
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
      approvals: createMemoryApprovalBridge({
        async onDecision(_request, decision) {
          input.decisions.push(`${decision.callId}:${decision.approved}`)
          return { ok: true }
        },
      }),
      judge: input.judge,
      ...(input.approvalHistory ? { approvalHistory: input.approvalHistory } : {}),
    })
    return { core, chunks, rt }
  }

  async function withPendingApproval(input: {
    judge: ApprovalJudge
    decisions: string[]
    approvalHistory?: Parameters<typeof createChannelCore>[0]["approvalHistory"]
  }) {
    const harness = judgedCore(input)
    await harness.core.handleInbound(envelope({ text: "needs approval" }), {
      reply: (chunk) => harness.chunks.push(chunk),
    })
    return harness
  }

  test("a natural-language yes decides the pending prompt", async () => {
    const decisions: string[] = []
    const { core, chunks, rt } = await withPendingApproval({
      decisions,
      judge: async () => ({ decision: "approved" }),
    })

    await core.handleInbound(envelope({
      idempotencyKey: "reply-1",
      text: "yeah go ahead",
    }), { reply: (chunk) => chunks.push(chunk) })

    expect(decisions).toEqual(["ses_1:perm_1:true"])
    expect(chunks.at(-1)).toEqual({ kind: "text", text: "Approved.", final: true })
    // The reply answered the prompt; it must not also reach the session.
    expect(rt.sent).toEqual(["ses_1:needs approval"])
  })

  test("a natural-language no denies the pending prompt", async () => {
    const decisions: string[] = []
    const { core, chunks } = await withPendingApproval({
      decisions,
      judge: async () => ({ decision: "denied" }),
    })

    await core.handleInbound(envelope({
      idempotencyKey: "reply-1",
      text: "no, don't do that",
    }), { reply: (chunk) => chunks.push(chunk) })

    expect(decisions).toEqual(["ses_1:perm_1:false"])
    expect(chunks.at(-1)).toEqual({ kind: "text", text: "Denied.", final: true })
  })

  test("a vague reply re-asks and leaves the prompt pending", async () => {
    const decisions: string[] = []
    const verdicts: ApprovalJudgeVerdict[] = [
      { decision: "unclear", question: "Sorry — approve or deny the bash command?" },
      { decision: "approved" },
    ]
    const { core, chunks } = await withPendingApproval({
      decisions,
      judge: async () => verdicts.shift()!,
    })

    await core.handleInbound(envelope({ idempotencyKey: "reply-1", text: "hmm" }), {
      reply: (chunk) => chunks.push(chunk),
    })

    expect(decisions).toEqual([])
    expect(chunks.at(-1)).toEqual({
      kind: "text",
      text: "Sorry — approve or deny the bash command?",
      final: true,
    })

    // Still pending: the follow-up answer lands on the same prompt.
    await core.handleInbound(envelope({ idempotencyKey: "reply-2", text: "yes, approve it" }), {
      reply: (chunk) => chunks.push(chunk),
    })
    expect(decisions).toEqual(["ses_1:perm_1:true"])
  })

  test("a broken judge re-asks rather than deciding", async () => {
    const decisions: string[] = []
    const { core, chunks } = await withPendingApproval({
      decisions,
      judge: async () => {
        throw new Error("model unavailable")
      },
    })

    await core.handleInbound(envelope({ idempotencyKey: "reply-1", text: "yes" }), {
      reply: (chunk) => chunks.push(chunk),
    })

    expect(decisions).toEqual([])
    expect(chunks.at(-1)).toEqual({ kind: "text", text: APPROVAL_UNCLEAR_REPLY, final: true })
  })

  test("the judge receives conversation history for the pending prompt", async () => {
    const decisions: string[] = []
    const seen: (readonly ApprovalJudgeTurn[] | undefined)[] = []
    const { core, chunks } = await withPendingApproval({
      decisions,
      async approvalHistory() {
        return [{ role: "assistant", text: "Should I run the migration?" }]
      },
      judge: async (input) => {
        seen.push(input.history)
        return { decision: "approved" }
      },
    })

    await core.handleInbound(envelope({ idempotencyKey: "reply-1", text: "do it" }), {
      reply: (chunk) => chunks.push(chunk),
    })

    expect(seen[0]).toEqual([{ role: "assistant", text: "Should I run the migration?" }])
  })

  test("free text with no pending prompt reaches the session untouched", async () => {
    const decisions: string[] = []
    let consulted = 0
    const { core, chunks, rt } = judgedCore({
      decisions,
      judge: async () => {
        consulted += 1
        return { decision: "approved" }
      },
    })

    // "no thanks" is prose, not a denial — with nothing pending it is a message.
    await core.handleInbound(envelope({ text: "no thanks" }), {
      reply: (chunk) => chunks.push(chunk),
    })

    expect(consulted).toBe(0)
    expect(decisions).toEqual([])
    expect(rt.sent).toEqual(["ses_1:no thanks"])
  })

  test("slash commands still win over a pending approval", async () => {
    const decisions: string[] = []
    let consulted = 0
    const { core, chunks, rt } = await withPendingApproval({
      decisions,
      judge: async () => {
        consulted += 1
        return { decision: "approved" }
      },
    })

    await core.handleInbound(envelope({
      idempotencyKey: "reply-1",
      text: "/stop",
      intent: { kind: "cancel" },
    }), { reply: (chunk) => chunks.push(chunk) })

    expect(consulted).toBe(0)
    expect(decisions).toEqual([])
    expect(rt.aborted).toEqual(["ses_1"])
  })

  test("without a judge, free text is never treated as an approval", async () => {
    const rt = runtime()
    const chunks: OutboundChunk[] = []
    const decisions: string[] = []
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
      approvals: createMemoryApprovalBridge({
        async onDecision(_request, decision) {
          decisions.push(`${decision.callId}:${decision.approved}`)
          return { ok: true }
        },
      }),
    })

    await core.handleInbound(envelope({ text: "needs approval" }), { reply: (chunk) => chunks.push(chunk) })
    await core.handleInbound(envelope({ idempotencyKey: "reply-1", text: "yes" }), {
      reply: (chunk) => chunks.push(chunk),
    })

    expect(decisions).toEqual([])
    expect(rt.sent).toEqual(["ses_1:needs approval", "ses_1:yes"])
  })
})

describe("runtime permission payload mapping", () => {
  test("reads the tool classification and title from the emitted payload shape", async () => {
    const rt = runtime()
    const chunks: OutboundChunk[] = []
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
      approvals: createMemoryApprovalBridge(),
    })

    await core.handleInbound(envelope({ text: "acp permission" }), { reply: (chunk) => chunks.push(chunk) })

    const approval = chunks.find((chunk): chunk is Extract<OutboundChunk, { kind: "approval" }> => chunk.kind === "approval")
    // `permission` + `metadata.title` are where the runtime actually puts these;
    // reading `tool`/`title` off the top level yielded "tool" / the generic
    // fallback for every prompt, which is what a human and the judge read.
    expect(approval?.request.tool).toBe("execute")
    expect(approval?.request.summary).toBe("Run the database migration")
  })

  test("falls back to the requested paths when the payload carries no title", async () => {
    const rt = runtime()
    const chunks: OutboundChunk[] = []
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
      approvals: createMemoryApprovalBridge(),
    })

    await core.handleInbound(envelope({ text: "acp permission untitled" }), { reply: (chunk) => chunks.push(chunk) })

    const approval = chunks.find((chunk): chunk is Extract<OutboundChunk, { kind: "approval" }> => chunk.kind === "approval")
    expect(approval?.request.summary).toBe("Permission is required for src/index.ts, src/app.ts.")
  })
})
