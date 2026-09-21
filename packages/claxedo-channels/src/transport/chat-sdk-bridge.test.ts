import { describe, expect, test, vi } from "vitest"
import {
  createChatSdkBridge,
  chatSdkEnvelope,
  type ChatSdkBot,
  type ChatSdkBridgeThread,
  type ChatSdkMessage,
} from "./chat-sdk-bridge"
import type { ChannelCore } from "../core/command-emit"

/**
 * `ChatSdkThread.post` receives a string or an AsyncIterable of deltas; the
 * real SDK renders both. Draining it here records what a channel would show.
 */
async function postedText(text: string | AsyncIterable<string>): Promise<string> {
  if (typeof text === "string") return text
  let rendered = ""
  for await (const chunk of text) rendered += chunk
  return rendered
}

describe("chat sdk bridge", () => {
  test("normalizes SDK thread and message objects into channel envelopes", () => {
    expect(chatSdkEnvelope({
      adapter: { name: "github" },
      installationId: "install",
      conversationId: "repo",
      id: "issue-1",
      post: async () => ({}),
    }, {
      id: "delivery-1",
      text: "@claxedo hello",
      author: { userId: "583231", userName: "octocat", fullName: "octocat" },
    })).toMatchObject({
      channel: "github",
      externalUserId: "583231",
      threadKey: "github:install:repo:issue-1",
      idempotencyKey: "delivery-1",
      text: "@claxedo hello",
      intent: { kind: "message" },
    })
  })

  test("takes the platform from the SDK adapter, not from a stringly thread field", () => {
    // A real `Thread.channel` is a Channel object, so `adapter.name` is the only
    // platform the SDK actually hands over.
    expect(chatSdkEnvelope({
      adapter: { name: "slack" },
      channelId: "C456",
      id: "1710000000.123",
      post: async () => ({}),
    }, {
      id: "slack-delivery",
      text: "hello",
      author: { userId: "U123" },
    })).toMatchObject({
      channel: "slack",
      threadKey: "slack:default:C456:1710000000.123",
    })
  })

  test("drops a message from a platform this build does not run", () => {
    // The channel is half of the `channel:externalUserId` key the access gate
    // admits on. Naming an unknown transport after a known one would file its
    // senders under that platform's allowlist.
    expect(chatSdkEnvelope({
      adapter: { name: "matrix" },
      channelId: "C456",
      id: "thread",
      post: async () => ({}),
    }, {
      id: "m1",
      text: "hello",
      author: { userId: "U123" },
    })).toBeUndefined()
    expect(chatSdkEnvelope({
      channelId: "C456",
      id: "thread",
      post: async () => ({}),
    }, {
      id: "m1",
      text: "hello",
      author: { userId: "U123" },
    })).toBeUndefined()
  })

  test("drops a message the SDK gave no stable author id for", () => {
    // `userName` sits right beside `userId` on the SDK author and is renameable,
    // so an absent id resolves to nobody rather than to the handle.
    const thread: ChatSdkBridgeThread = {
      adapter: { name: "slack" },
      conversationId: "D1",
      post: async () => ({}),
    }
    expect(chatSdkEnvelope(thread, { id: "m1", text: "hello" })).toBeUndefined()
    expect(chatSdkEnvelope(thread, {
      id: "m2",
      text: "hello",
      author: { userId: "   ", userName: "owner" },
    })).toBeUndefined()
  })

  test("never classifies free text as an approval reply", () => {
    // Approvals come from card buttons or the judge, never from parsing prose.
    // "deny a7f3" reads like a decision; "no thanks" does not, and the old
    // regex treated both as one. Both are plain messages at this boundary.
    for (const text of ["deny a7f3", "no thanks", "yes please", "approve this"]) {
      expect(chatSdkEnvelope({
        adapter: { name: "telegram" },
        id: "chat",
        post: async () => ({}),
      }, {
        id: "msg",
        text,
        author: { userId: "4242" },
        raw: { from: { id: 4242 }, chat: { id: 4242 } },
      })).toMatchObject({ intent: { kind: "message" } })
    }
  })

  test("uses stable idempotency fallback and receivedAt when SDK messages have no id", () => {
    expect(chatSdkEnvelope({
      adapter: { name: "telegram" },
      id: "chat",
      post: async () => ({}),
    }, {
      text: "hello",
      timestamp: 1_700_000_000,
      author: { userId: "4242" },
      raw: { from: { id: 4242 }, chat: { id: 4242 } },
    })).toMatchObject({
      idempotencyKey: "telegram:default:chat:chat:1700000000000:hello",
      receivedAt: 1_700_000_000_000,
    })
  })

  test("uses Slack team, channel, and thread timestamp for thread keys", () => {
    expect(chatSdkEnvelope({
      adapter: { name: "slack" },
      teamId: "T123",
      channelId: "C456",
      id: "top-level-message",
      threadTs: "1710000000.123",
      post: async () => ({}),
    }, {
      id: "slack-delivery",
      text: "hello",
      author: { userId: "U123" },
    })).toMatchObject({
      channel: "slack",
      threadKey: "slack:T123:C456:1710000000.123",
    })
  })

  test("parses repo targets from chat-shaped transport text", () => {
    expect(chatSdkEnvelope({
      adapter: { name: "slack" },
      teamId: "T123",
      channelId: "C456",
      threadTs: "1710000000.123",
      post: async () => ({}),
    }, {
      id: "slack-delivery",
      text: "repo:acme/tools fix the failing test",
      author: { userId: "U123" },
    })).toMatchObject({
      repo: { owner: "acme", name: "tools" },
    })
  })

  test("uses Discord guild, channel, and thread/message ids for thread keys", () => {
    expect(chatSdkEnvelope({
      adapter: { name: "discord" },
      guildId: "G123",
      channelId: "C456",
      threadId: "M789",
      post: async () => ({}),
    }, {
      id: "discord-delivery",
      text: "hello",
      author: { userId: "D123" },
    })).toMatchObject({
      channel: "discord",
      threadKey: "discord:G123:C456:M789",
    })
  })

  test("classifies the chat surface from the SDK thread", async () => {
    const classify = (thread: Partial<ChatSdkBridgeThread>) => chatSdkEnvelope(
      { post: async () => ({}), ...thread },
      { id: "msg", text: "hi", author: { userId: "7" }, raw: { from: { id: 7 } } },
    )?.chatType
    // The SDK's own `isDM` wins outright.
    expect(classify({ adapter: { name: "slack" }, isDM: true, channelId: "C1", teamId: "T1" })).toBe("dm")
    expect(classify({ adapter: { name: "slack" }, isDM: false, conversationId: "D1" })).toBe("group")
    // Without it, a shared-room id (Discord guild, Slack workspace, channel)
    // means other people are present.
    expect(classify({ adapter: { name: "discord" }, guildId: "G1" })).toBe("group")
    expect(classify({ adapter: { name: "slack" }, teamId: "T1" })).toBe("group")
    expect(classify({ adapter: { name: "slack" }, channelId: "C1" })).toBe("group")
    // A bare conversation id is a 1:1 thread.
    expect(classify({ adapter: { name: "telegram" }, conversationId: "D1" })).toBe("dm")
    // Nothing to go on → the stricter group surface.
    expect(classify({ adapter: { name: "telegram" }, id: "t1" })).toBe("group")
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
    const thread: ChatSdkBridgeThread = { id: "t", adapter: { name: "slack" }, channelId: "C1", post: async () => ({}) }
    const author = { userId: "U123" }

    await mention(thread, { id: "m1", text: "hey bot", author })
    await subscribed(thread, { id: "m2", text: "unrelated chatter", author })
    // An SDK that marks the message itself also counts.
    await subscribed(thread, { id: "m3", text: "hey bot", isMention: true, author })

    expect(seen).toEqual([["@bot"], undefined, ["@bot"]])
  })

  test("refuses an unidentified message before subscribing the bot to the thread", async () => {
    // Subscribing makes the bot a participant in a stranger's thread and is a
    // side effect on the platform, so it must not happen for a message no
    // policy could have admitted.
    let mention!: (thread: ChatSdkBridgeThread, message: ChatSdkMessage) => Promise<void>
    const core: ChannelCore = {
      handleInbound: vi.fn(),
      onApproval: vi.fn(async () => ({ ok: true as const })),
    }
    const subscribe = vi.fn()
    createChatSdkBridge({
      bot: {
        onNewMention(handler) {
          mention = handler
        },
      },
      core,
    })

    await mention(
      { id: "t", adapter: { name: "slack" }, channelId: "C1", subscribe, post: async () => ({}) },
      { id: "m1", text: "@claxedo hello", author: { userName: "octocat" } as never },
    )

    expect(subscribe).not.toHaveBeenCalled()
    expect(core.handleInbound).not.toHaveBeenCalled()
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
      thread: { adapter: { name: "slack" }, teamId: "T123", channelId: "C456", threadTs: "1710000000.123" },
      data: { token: "slack7", approved: true },
      user: { userId: "U123", userName: "octocat" },
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
      adapter: { name: "discord" },
      guildId: "G123",
      channelId: "C456",
      threadId: "M789",
      value: "approve",
      payload: { callId: "ses_1:perm_1" },
      user: { userId: "D1" },
    })

    // Same composition as the inbound Discord envelope, so the keys match.
    expect(core.onApproval).toHaveBeenCalledWith({
      callId: "ses_1:perm_1",
      approved: true,
      actorExternalUserId: "D1",
      threadKey: "discord:G123:C456:M789",
    })
  })

  test("drops a press from a thread on a platform this build does not run", async () => {
    // No inbound message from that platform can have opened a prompt, so any
    // prompt this press would resolve belongs to another thread.
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
      thread: { adapter: { name: "matrix" }, channelId: "C456", id: "room" },
      data: { token: "slack7", approved: true },
      user: { userId: "U123" },
    })

    expect(core.onApproval).not.toHaveBeenCalled()
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

    await action({ data: { token: "tok", approved: true }, user: { userId: "U1" } })

    expect(core.onApproval).toHaveBeenCalledWith({
      token: "tok",
      approved: true,
      actorExternalUserId: "U1",
    })
  })

  test("wires mentions and action callbacks to core", async () => {
    let mention!: (thread: ChatSdkBridgeThread, message: ChatSdkMessage) => Promise<void>
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
    await mention({
      id: "thread",
      adapter: { name: "telegram" },
      post: async (text) => posted.push(await postedText(text)),
    }, {
      id: "msg",
      text: "hello",
      author: { userId: "4242" },
      raw: { from: { id: 4242 }, chat: { id: 4242 } },
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
    let mention!: (thread: ChatSdkBridgeThread, message: ChatSdkMessage) => Promise<void>
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
    await mention({
      id: "thread",
      adapter: { name: "slack" },
      post: async (text) => posted.push(await postedText(text)),
    }, {
      id: "msg",
      text: "hello",
      author: { userId: "U1" },
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
      user: { userId: "U999" },
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
      adapter: { name: "slack" },
      data: { token: "slack7", approved: true },
      user: { userId: "U123" },
    })
    await action({
      adapter: { name: "discord" },
      value: "deny",
      payload: { callId: "ses_1:perm_3" },
      user: { userId: "discord-user" },
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
