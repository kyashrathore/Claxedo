import { describe, expect, test, vi } from "vitest"
import { createChatSdkBot, createChatSdkChannelBot } from "./chat-sdk-adapters"
import type { ChannelRegistration } from "../registry"

const registrations: ChannelRegistration[] = [{
  channel: "github",
  enabled: true,
  transport: "chat-sdk",
  reason: "test",
  webhookPath: "/github",
}, {
  channel: "telegram",
  enabled: true,
  transport: "chat-sdk",
  reason: "test",
  webhookPath: "/telegram",
}, {
  channel: "whatsapp",
  enabled: true,
  transport: "baileys",
  reason: "test",
  webhookPath: "/whatsapp",
}]

describe("createChatSdkBot", () => {
  test("loads only enabled Chat SDK adapters by current package names", async () => {
    const loaded: string[] = []
    const bot = await createChatSdkBot({
      registrations,
      userName: "claxedo",
      async importer(specifier) {
        loaded.push(specifier)
        if (specifier === "chat") {
          return {
            Chat: class {
              adapters: Record<string, unknown>
              constructor(input: { adapters: Record<string, unknown> }) {
                this.adapters = input.adapters
              }
            },
          }
        }
        return {
          createGitHubAdapter: () => "github-adapter",
          createTelegramAdapter: () => "telegram-adapter",
        }
      },
    }) as unknown as { adapters: Record<string, unknown> }

    expect(loaded).toEqual(["chat", "@chat-adapter/github", "@chat-adapter/telegram"])
    expect(bot.adapters).toEqual({ github: "github-adapter", telegram: "telegram-adapter" })
  })

  test("registers Chat SDK handlers against the channel core", async () => {
    let mention: ((thread: { id: string; channel: string; post: (text: string) => void }, message: { id: string; text: string }) => Promise<void>) | undefined
    const core = {
      handleInbound: vi.fn(async (_input, handlers) => {
        await handlers.reply({ kind: "text" as const, text: "ok", final: true })
      }),
      onApproval: vi.fn(async () => ({ ok: true as const })),
    }

    await createChatSdkChannelBot({
      registrations: [registrations[1]],
      userName: "claxedo",
      core,
      async importer(specifier) {
        if (specifier === "chat") {
          return {
            Chat: class {
              webhooks = { telegram: async () => new Response("ok") }
              constructor() {}
              onNewMention(handler: typeof mention) {
                mention = handler
              }
              onSubscribedMessage() {}
            },
          }
        }
        return { createTelegramAdapter: () => "telegram-adapter" }
      },
    })

    const posts: string[] = []
    await mention?.({ id: "chat", channel: "telegram", post: (text) => posts.push(text) }, {
      id: "msg",
      text: "hello",
    })

    expect(core.handleInbound).toHaveBeenCalledWith(expect.objectContaining({ text: "hello" }), expect.any(Object))
    expect(posts).toEqual(["ok"])
  })

  test("skips failed adapters without losing healthy channel handlers", async () => {
    const errors: string[] = []
    const bot = await createChatSdkBot({
      registrations,
      userName: "claxedo",
      onAdapterError(input) {
        errors.push(input.channel)
      },
      async importer(specifier) {
        if (specifier === "chat") {
          return {
            Chat: class {
              adapters: Record<string, unknown>
              constructor(input: { adapters: Record<string, unknown> }) {
                this.adapters = input.adapters
              }
            },
          }
        }
        if (specifier === "@chat-adapter/github") throw new Error("github config missing")
        return {
          createTelegramAdapter: () => "telegram-adapter",
        }
      },
    }) as unknown as { adapters: Record<string, unknown> }

    expect(errors).toEqual(["github"])
    expect(bot.adapters).toEqual({ telegram: "telegram-adapter" })
  })

  test("loads the official WhatsApp Chat SDK adapter when configured", async () => {
    const loaded: string[] = []
    const bot = await createChatSdkBot({
      registrations: [{
        channel: "whatsapp",
        enabled: true,
        transport: "chat-sdk",
        reason: "test",
        webhookPath: "/whatsapp",
      }],
      userName: "claxedo",
      async importer(specifier) {
        loaded.push(specifier)
        if (specifier === "chat") {
          return {
            Chat: class {
              adapters: Record<string, unknown>
              constructor(input: { adapters: Record<string, unknown> }) {
                this.adapters = input.adapters
              }
            },
          }
        }
        return { createWhatsAppAdapter: () => "whatsapp-adapter" }
      },
    }) as unknown as { adapters: Record<string, unknown> }

    expect(loaded).toEqual(["chat", "@chat-adapter/whatsapp"])
    expect(bot.adapters).toEqual({ whatsapp: "whatsapp-adapter" })
  })

  test("loads Slack and Discord Chat SDK adapters for team-chat channels", async () => {
    const loaded: string[] = []
    const bot = await createChatSdkBot({
      registrations: [{
        channel: "slack",
        enabled: true,
        transport: "chat-sdk",
        reason: "test",
        webhookPath: "/slack",
      }, {
        channel: "discord",
        enabled: true,
        transport: "chat-sdk",
        reason: "test",
        webhookPath: "/discord",
      }],
      userName: "claxedo",
      async importer(specifier) {
        loaded.push(specifier)
        if (specifier === "chat") {
          return {
            Chat: class {
              adapters: Record<string, unknown>
              constructor(input: { adapters: Record<string, unknown> }) {
                this.adapters = input.adapters
              }
            },
          }
        }
        if (specifier === "@chat-adapter/slack") return { createSlackAdapter: () => "slack-adapter" }
        return { createDiscordAdapter: () => "discord-adapter" }
      },
    }) as unknown as { adapters: Record<string, unknown> }

    expect(loaded).toEqual(["chat", "@chat-adapter/slack", "@chat-adapter/discord"])
    expect(bot.adapters).toEqual({ slack: "slack-adapter", discord: "discord-adapter" })
  })
})
