import { describe, expect, test } from "vitest"
import {
  createChannelAccess,
  createChannelCore,
  createMemoryChannelAccessStore,
  createMemoryDedupStore,
  createMemorySessionResolver,
  createSlidingWindowRateLimiter,
  type ChannelDenialReason,
  type ChannelRuntime,
  type InboundEnvelope,
  type OutboundChunk,
} from "../index"

function envelope(input: Partial<InboundEnvelope> = {}): InboundEnvelope {
  return {
    channel: "telegram",
    externalUserId: "stranger",
    threadKey: "telegram:install:chat:thread",
    idempotencyKey: `d-${Math.random()}`,
    text: "hello",
    receivedAt: Date.now(),
    chatType: "dm",
    raw: {},
    ...input,
  }
}

function runtime(): ChannelRuntime & { created: string[]; sent: string[]; aborted: string[] } {
  const created: string[] = []
  const sent: string[] = []
  const aborted: string[] = []
  return {
    created, sent, aborted,
    async createSession(input) {
      const sessionId = `ses_${created.length + 1}`
      created.push(input.threadKey)
      return { sessionId, appUrl: `/s/${sessionId}` }
    },
    async *sendMessage(input) {
      sent.push(`${input.sessionId}:${input.text}`)
      yield { type: "text-delta", delta: `echo:${input.text}` }
      yield { type: "finish", sessionId: input.sessionId }
    },
    async abortSession(input) {
      aborted.push(input.sessionId)
      return { ok: true, status: "cancelled" }
    },
  }
}

describe("access gate wired into the core", () => {
  test("unpaired stranger gets a pairing reply and NEVER reaches the runtime", async () => {
    const rt = runtime()
    const denials: ChannelDenialReason[] = []
    const access = createChannelAccess({
      dmPolicy: "pairing",
      store: createMemoryChannelAccessStore(),
      now: () => 1_000_000,
      random: () => 0.1,
    })
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
      access,
      onDenial: (_e, reason) => { denials.push(reason as ChannelDenialReason) },
    })
    const chunks: OutboundChunk[] = []
    await core.handleInbound(envelope(), { reply: (c) => chunks.push(c) })

    expect(rt.created).toEqual([]) // no session
    expect(rt.sent).toEqual([]) // no LLM turn
    expect(denials).toEqual(["dm_pairing_required"])
    expect(chunks).toEqual([{ kind: "text", text: expect.stringContaining("pairing"), final: true }])
  })

  test("approved sender flows through to a real turn", async () => {
    const rt = runtime()
    const store = createMemoryChannelAccessStore()
    const access = createChannelAccess({ dmPolicy: "pairing", store, now: () => 1_000_000, random: () => 0.1 })
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
      access,
    })
    // Stranger pairs, owner approves, stranger retries.
    await core.handleInbound(envelope(), { reply: () => {} })
    const [pending] = await access.listPending("telegram")
    await access.approve(pending.code, "owner")
    await core.handleInbound(envelope({ idempotencyKey: "d-2" }), { reply: () => {} })
    expect(rt.sent).toEqual(["ses_1:hello"])
  })

  test("budget veto refuses message turns once the cap is hit, but not commands", async () => {
    const rt = runtime()
    let used = 0
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
      access: createChannelAccess({ dmPolicy: "open", store: createMemoryChannelAccessStore() }),
      budget: async () => (used++ >= 1 ? { ok: false, message: "Daily limit reached (1 messages). Try again tomorrow." } : { ok: true }),
    })
    // First message allowed.
    await core.handleInbound(envelope({ idempotencyKey: "a" }), { reply: () => {} })
    expect(rt.sent).toHaveLength(1)
    // Second refused with the cap notice.
    const chunks: OutboundChunk[] = []
    await core.handleInbound(envelope({ idempotencyKey: "b" }), { reply: (c) => chunks.push(c) })
    expect(rt.sent).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ text: expect.stringContaining("Daily limit") })
    // A command (/whoami) still works while over budget.
    chunks.length = 0
    await core.handleInbound(envelope({ text: "/whoami", intent: { kind: "whoami" } }), { reply: (c) => chunks.push(c) })
    expect(chunks[0]).toMatchObject({ text: expect.stringContaining("telegram:stranger") })
  })

  test("rate limit drops an allowed-but-abusive sender before a turn", async () => {
    const rt = runtime()
    const denials: string[] = []
    const rateLimiter = createSlidingWindowRateLimiter({ limit: 1, windowMs: 60_000 })
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
      access: createChannelAccess({ dmPolicy: "open", store: createMemoryChannelAccessStore() }),
      rateLimiter,
      onDenial: (_e, reason) => denials.push(reason),
    })
    await core.handleInbound(envelope({ idempotencyKey: "a" }), { reply: () => {} })
    await core.handleInbound(envelope({ idempotencyKey: "b" }), { reply: () => {} })
    expect(rt.sent).toHaveLength(1)
    expect(denials).toEqual(["rate_limited"])
  })
})

describe("session lifecycle commands", () => {
  const openAccess = () => createChannelAccess({ dmPolicy: "open", store: createMemoryChannelAccessStore() })

  test("/whoami echoes the allowlistable id without a session", async () => {
    const rt = runtime()
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
      access: openAccess(),
    })
    const chunks: OutboundChunk[] = []
    await core.handleInbound(envelope({ text: "/whoami", intent: { kind: "whoami" } }), { reply: (c) => chunks.push(c) })
    expect(rt.created).toEqual([])
    expect(chunks[0]).toMatchObject({ kind: "text", text: expect.stringContaining("telegram:stranger") })
  })

  test("/new aborts the active session and resets the binding", async () => {
    const rt = runtime()
    const sessions = createMemorySessionResolver(rt)
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions,
      access: openAccess(),
      resetSession: (threadKey) => sessions.reset!(threadKey),
    })
    // First message opens ses_1.
    await core.handleInbound(envelope({ idempotencyKey: "a" }), { reply: () => {} })
    // /new aborts + resets.
    await core.handleInbound(envelope({ idempotencyKey: "b", text: "/new", intent: { kind: "new_session" } }), { reply: () => {} })
    expect(rt.aborted).toEqual(["ses_1"])
    // Next message opens a DISTINCT session.
    await core.handleInbound(envelope({ idempotencyKey: "c" }), { reply: () => {} })
    expect(rt.created).toEqual(["telegram:install:chat:thread", "telegram:install:chat:thread"])
    expect(rt.sent).toEqual(["ses_1:hello", "ses_2:hello"])
  })

  test("/sessions lists this sender's sessions", async () => {
    const rt = runtime()
    const core = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
      access: openAccess(),
      listSessions: async () => [{ sessionId: "ses_9", title: "Old chat", appUrl: "/s/ses_9" }],
    })
    const chunks: OutboundChunk[] = []
    await core.handleInbound(envelope({ text: "/sessions", intent: { kind: "list_sessions" } }), { reply: (c) => chunks.push(c) })
    expect(chunks[0]).toMatchObject({ kind: "text", text: expect.stringContaining("Old chat") })
  })

  test("/pairing approve requires an administrator", async () => {
    const rt = runtime()
    const store = createMemoryChannelAccessStore()
    // owner + rando are allowlisted (so they pass the gate); only the admin
    // may actually approve. victim is an unpaired stranger.
    const access = createChannelAccess({
      dmPolicy: "pairing",
      store,
      allowFrom: ["telegram:owner", "telegram:rando"],
      random: () => 0.1,
    })
    await access.gate({ channel: "telegram", externalUserId: "victim", chatType: "dm" })
    const [pending] = await access.listPending("telegram")

    // Non-admin cannot approve.
    const nonAdmin = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
      access,
      canAdminister: () => false,
    })
    let chunks: OutboundChunk[] = []
    await nonAdmin.handleInbound(
      envelope({ externalUserId: "rando", text: `/pairing approve ${pending.code}`, intent: { kind: "pairing_approve", code: pending.code } }),
      { reply: (c) => chunks.push(c) },
    )
    expect(chunks[0]).toMatchObject({ text: expect.stringContaining("not available") })
    expect(await access.listPending("telegram")).toHaveLength(1) // still pending

    // Admin can.
    const admin = createChannelCore({
      runtime: rt,
      dedup: createMemoryDedupStore({ initializedAt: 0 }),
      sessions: createMemorySessionResolver(rt),
      access,
      canAdminister: () => true,
    })
    chunks = []
    await admin.handleInbound(
      envelope({ externalUserId: "owner", text: `/pairing approve ${pending.code}`, intent: { kind: "pairing_approve", code: pending.code } }),
      { reply: (c) => chunks.push(c) },
    )
    expect(chunks[0]).toMatchObject({ text: expect.stringContaining("Approved telegram:victim") })
    expect(await access.listPending("telegram")).toHaveLength(0)
  })
})
