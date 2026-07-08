import { describe, expect, test } from "vitest"
import {
  createChannelCore,
  createMemoryApprovalBridge,
  createMemoryDedupStore,
  createMemorySessionResolver,
  ChannelSessionResolutionError,
  parseChannelCommand,
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
    await expect(core.onApproval({
      token: approval!.request.token,
      approved: false,
      actorExternalUserId: "approver",
    })).resolves.toEqual({ ok: true })

    expect(decisions).toEqual(["ses_1:perm_1:false:approver"])
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
