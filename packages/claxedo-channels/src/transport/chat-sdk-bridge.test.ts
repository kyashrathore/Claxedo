import { describe, expect, test, vi } from "vitest"
import {
  createChatSdkBridge,
  chatSdkEnvelope,
  type ChatSdkBot,
  type ChatSdkBridgeThread,
  type ChatSdkMessage,
} from "./chat-sdk-bridge"
import type { ChannelCore } from "../core/command-emit"

describe("chat sdk bridge", () => {
  test("normalizes SDK thread and message objects into channel envelopes", () => {
    expect(chatSdkEnvelope({
      channel: "github",
      installationId: "install",
      conversationId: "repo",
      id: "issue-1",
      post: async () => ({}),
    }, {
      id: "delivery-1",
      text: "@claxedo hello",
      author: { id: "octo" },
    })).toMatchObject({
      channel: "github",
      externalUserId: "octo",
      threadKey: "github:install:repo:issue-1",
      idempotencyKey: "delivery-1",
      text: "@claxedo hello",
      intent: { kind: "message" },
    })
  })

  test("never classifies free text as an approval reply", () => {
    // Approvals come from card buttons or the judge, never from parsing prose.
    // "deny a7f3" reads like a decision; "no thanks" does not, and the old
    // regex treated both as one. Both are plain messages at this boundary.
    for (const text of ["deny a7f3", "no thanks", "yes please", "approve this"]) {
      expect(chatSdkEnvelope({
        channel: "telegram",
        id: "chat",
        post: async () => ({}),
      }, {
        id: "msg",
        text,
        author: { id: "owner" },
      })).toMatchObject({ intent: { kind: "message" } })
    }
  })

  test("uses stable idempotency fallback and receivedAt when SDK messages have no id", () => {
    expect(chatSdkEnvelope({
      channel: "telegram",
      id: "chat",
      post: async () => ({}),
    }, {
      text: "hello",
      timestamp: 1_700_000_000,
      author: { id: "owner" },
    })).toMatchObject({
      idempotencyKey: "telegram:default:chat:chat:1700000000000:hello",
      receivedAt: 1_700_000_000_000,
    })
  })

  test("uses Slack team, channel, and thread timestamp for thread keys", () => {
    expect(chatSdkEnvelope({
      channel: "slack",
      teamId: "T123",
      channelId: "C456",
      id: "top-level-message",
      threadTs: "1710000000.123",
      post: async () => ({}),
    }, {
      id: "slack-delivery",
      text: "hello",
      author: { id: "U123" },
    })).toMatchObject({
      channel: "slack",
      threadKey: "slack:T123:C456:1710000000.123",
    })
  })

  test("parses repo targets from chat-shaped transport text", () => {
    expect(chatSdkEnvelope({
      channel: "slack",
      teamId: "T123",
      channelId: "C456",
      threadTs: "1710000000.123",
      post: async () => ({}),
    }, {
      id: "slack-delivery",
      text: "repo:acme/tools fix the failing test",
      author: { id: "U123" },
    })).toMatchObject({
      repo: { owner: "acme", name: "tools" },
    })
  })

  test("uses Discord guild, channel, and thread/message ids for thread keys", () => {
    expect(chatSdkEnvelope({
      channel: "discord",
      guildId: "G123",
      channelId: "C456",
      threadId: "M789",
      post: async () => ({}),
    }, {
      id: "discord-delivery",
      text: "hello",
      author: { id: "D123" },
    })).toMatchObject({
      channel: "discord",
      threadKey: "discord:G123:C456:M789",
    })
  })

  test("classifies the chat surface from the SDK thread", async () => {
    const classify = (thread: Partial<ChatSdkBridgeThread>) => chatSdkEnvelope(
      { post: async () => ({}), ...thread },
      { id: "msg", text: "hi", author: { id: "u" } },
    ).chatType
    // The SDK's own `isDM` wins outright.
    expect(classify({ channel: "slack", isDM: true, channelId: "C1", teamId: "T1" })).toBe("dm")
    expect(classify({ channel: "slack", isDM: false, conversationId: "D1" })).toBe("group")
    // Without it, a shared-room id (Discord guild, Slack workspace, channel)
    // means other people are present.
    expect(classify({ channel: "discord", guildId: "G1" })).toBe("group")
    expect(classify({ channel: "slack", teamId: "T1" })).toBe("group")
    expect(classify({ channel: "slack", channelId: "C1" })).toBe("group")
    // A bare conversation id is a 1:1 thread.
    expect(classify({ channel: "telegram", conversationId: "D1" })).toBe("dm")
    // Nothing to go on → the stricter group surface.
    expect(classify({ channel: "telegram", id: "t1" })).toBe("group")
  })

  test("treats an onNewMention delivery as addressed and a subscribed message as not", async () => {
    // `onNewMention` fires only for messages that addressed the bot, so the
    // delivery path is itself the evidence. `onSubscribedMessage` fires for
    // every message in the thread and carries no such claim — that difference
    // is what group mention-gating reads.
    let mention!: (thread: ChatSdkBridgeThread, message: ChatSdkMessage) => Promise<void>
    let subscribed!: (thread: ChatSdkBridgeThread, message: ChatSdkMessage) => Promise<void>
    const seen: (string[] | undefined)[] = []
    const bot: ChatSdkBot = {
      onNewMention(handler) {
        mention = handler
      },
      onSubscribedMessage(handler) {
        subscribed = handler
      },
    }
    createChatSdkBridge({
      bot,
      core: {
        handleInbound: vi.fn(async (input) => {
          seen.push(input.mentions)
        }),
        onApproval: vi.fn(async () => ({ ok: true as const })),
      },
    })
    const thread: ChatSdkBridgeThread = { id: "t", channel: "slack", channelId: "C1", post: async () => ({}) }

    await mention(thread, { id: "m1", text: "hey bot" })
    await subscribed(thread, { id: "m2", text: "unrelated chatter" })
    // An SDK that marks the message itself also counts.
    await subscribed(thread, { id: "m3", text: "hey bot", isMention: true })

    expect(seen).toEqual([["@bot"], undefined, ["@bot"]])
  })

  test("threads the acting thread's key through button approvals", async () => {
    // Without a threadKey the approval bridge's thread check compares against
    // undefined and never fires, so a press from any thread could resolve any
    // pending prompt.
    let action!: (input: unknown) => Promise<void>
    const bot: ChatSdkBot = {
      onAction(handler) {
        action = handler
      },
    }
    const core: ChannelCore = {
      handleInbound: vi.fn(),
      onApproval: vi.fn(async () => ({ ok: true as const })),
    }

    createChatSdkBridge({ bot, core })
    await action({
      thread: { channel: "slack", teamId: "T123", channelId: "C456", threadTs: "1710000000.123" },
      data: { token: "slack7", approved: true },
      user: { id: "U123" },
    })

    // Composed with the same threadKey() as inbound messages, so the two agree.
    expect(core.onApproval).toHaveBeenCalledWith({
      token: "slack7",
      approved: true,
      actorExternalUserId: "U123",
      threadKey: "slack:T123:C456:1710000000.123",
    })
  })

  test("reads thread ids inline when the action has no nested thread", async () => {
    let action!: (input: unknown) => Promise<void>
    const core: ChannelCore = {
      handleInbound: vi.fn(),
      onApproval: vi.fn(async () => ({ ok: true as const })),
    }
    createChatSdkBridge({
      bot: {
        onAction(handler) {
          action = handler
        },
      },
      core,
    })

    await action({
      channel: "discord",
      guildId: "G123",
      channelId: "C456",
      threadId: "M789",
      value: "approve",
      payload: { callId: "ses_1:perm_1" },
      user: { id: "D1" },
    })

    // Same composition as the inbound Discord envelope, so the keys match.
    expect(core.onApproval).toHaveBeenCalledWith({
      callId: "ses_1:perm_1",
      approved: true,
      actorExternalUserId: "D1",
      threadKey: "discord:G123:C456:M789",
    })
  })

  test("omits the threadKey when the action payload identifies no thread", async () => {
    // Better to send no key than one composed from defaults, which would match
    // an unrelated thread's prompt.
    let action!: (input: unknown) => Promise<void>
    const core: ChannelCore = {
      handleInbound: vi.fn(),
      onApproval: vi.fn(async () => ({ ok: true as const })),
    }
    createChatSdkBridge({
      bot: {
        onAction(handler) {
          action = handler
        },
      },
      core,
    })

    await action({ data: { token: "tok", approved: true }, user: { id: "U1" } })

    expect(core.onApproval).toHaveBeenCalledWith({
      token: "tok",
      approved: true,
      actorExternalUserId: "U1",
    })
  })

  test("wires mentions and action callbacks to core", async () => {
    let mention!: (thread: ChatSdkBridgeThread, message: { id: string; text: string }) => Promise<void>
    let action!: (input: unknown) => Promise<void>
    const bot: ChatSdkBot = {
      onNewMention(handler) {
        mention = handler
      },
      onAction(handler) {
        action = handler
      },
    }
    const core: ChannelCore = {
      handleInbound: vi.fn(async (_input, handlers) => {
        await handlers.reply({ kind: "text", text: "ok", final: true })
      }),
      onApproval: vi.fn(async () => ({ ok: true as const })),
    }
    const posted: string[] = []

    createChatSdkBridge({
      bot,
      core,
      toApprovalDecision: () => ({ callId: "call_1", approved: true, actorExternalUserId: "user_1" }),
    })
    await mention({ id: "thread", channel: "telegram", post: async (text) => posted.push(String(text)) }, {
      id: "msg",
      text: "hello",
    })
    await action({})

    expect(core.handleInbound).toHaveBeenCalledWith(expect.objectContaining({ text: "hello" }), expect.any(Object))
    expect(posted).toEqual(["ok"])
    expect(core.onApproval).toHaveBeenCalledWith({
      callId: "call_1",
      approved: true,
      actorExternalUserId: "user_1",
    })
  })

  test("applies data minimization to replies emitted through the bridge renderer", async () => {
    let mention!: (thread: ChatSdkBridgeThread, message: { id: string; text: string }) => Promise<void>
    const bot: ChatSdkBot = {
      onNewMention(handler) {
        mention = handler
      },
    }
    const core: ChannelCore = {
      handleInbound: vi.fn(async (_input, handlers) => {
        await handlers.reply({
          kind: "text",
          text: `token sk-abcdefghijklmnopqrstuvwxyz123456 ${"x".repeat(120)}`,
          final: true,
        })
      }),
      onApproval: vi.fn(async () => ({ ok: true as const })),
    }
    const posted: string[] = []

    createChatSdkBridge({
      bot,
      core,
      dataMinimization: { maxLength: 90 },
    })
    await mention({ id: "thread", channel: "slack", post: async (text) => posted.push(String(text)) }, {
      id: "msg",
      text: "hello",
    })

    expect(posted[0]).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456")
    expect(posted[0]).toContain("[redacted token]")
    expect(posted[0]).toContain("[truncated; open the session link for full output]")
    expect(posted[0].length).toBeLessThanOrEqual(90)
  })

  test("uses the default approval action parser", async () => {
    let action!: (input: unknown) => Promise<void>
    const bot: ChatSdkBot = {
      onAction(handler) {
        action = handler
      },
    }
    const core: ChannelCore = {
      handleInbound: vi.fn(),
      onApproval: vi.fn(async () => ({ ok: true as const })),
    }

    createChatSdkBridge({ bot, core })
    await action({
      action_id: "deny_permission",
      call_id: "ses_1:perm_1",
      actor: { id: "U999" },
    })

    expect(core.onApproval).toHaveBeenCalledWith({
      callId: "ses_1:perm_1",
      approved: false,
      actorExternalUserId: "U999",
    })
  })

  test("routes Slack and Discord approval actions through the same core callback", async () => {
    let action!: (input: unknown) => Promise<void>
    const bot: ChatSdkBot = {
      onAction(handler) {
        action = handler
      },
    }
    const core: ChannelCore = {
      handleInbound: vi.fn(),
      onApproval: vi.fn(async () => ({ ok: true as const })),
    }

    createChatSdkBridge({ bot, core })
    await action({
      channel: "slack",
      data: { token: "slack7", approved: true },
      user: { id: "U123" },
    })
    await action({
      channel: "discord",
      value: "deny",
      payload: { callId: "ses_1:perm_3" },
      interaction: { user: { id: "discord-user" } },
    })

    expect(core.onApproval).toHaveBeenNthCalledWith(1, {
      token: "slack7",
      approved: true,
      actorExternalUserId: "U123",
    })
    expect(core.onApproval).toHaveBeenNthCalledWith(2, {
      callId: "ses_1:perm_3",
      approved: false,
      actorExternalUserId: "discord-user",
    })
  })
})
