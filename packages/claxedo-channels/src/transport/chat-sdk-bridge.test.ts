import { describe, expect, test, vi } from "vitest"
import { createChatSdkBridge, chatSdkEnvelope, type ChatSdkBot, type ChatSdkBridgeThread } from "./chat-sdk-bridge"
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

  test("parses numbered approval replies before they reach core", () => {
    expect(chatSdkEnvelope({
      channel: "telegram",
      id: "chat",
      post: async () => ({}),
    }, {
      id: "msg",
      text: "deny a7f3",
      author: { id: "owner" },
    })).toMatchObject({
      intent: { kind: "approval_reply", approved: false, token: "a7f3" },
    })
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
      onApproval: vi.fn(async () => ({ ok: true })),
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
      onApproval: vi.fn(async () => ({ ok: true })),
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
      onApproval: vi.fn(async () => ({ ok: true })),
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
      onApproval: vi.fn(async () => ({ ok: true })),
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
