import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createChatSdkBot, createChatSdkChannelBot } from "./chat-sdk-adapters"
import { createChannelRegistry, type ChannelRegistration } from "../registry"

class FakeChat {
  adapters: Record<string, unknown>
  constructor(input: { adapters: Record<string, unknown> }) {
    this.adapters = input.adapters
  }
}

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
  adapterConfig: { botToken: "bot", secretToken: "secret" },
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
            Chat: FakeChat,
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

  test("constructs each adapter with the registration's resolved configuration", async () => {
    const configs: Record<string, unknown> = {}
    await createChatSdkBot({
      registrations,
      userName: "claxedo",
      async importer(specifier) {
        if (specifier === "chat") return { Chat: FakeChat }
        return {
          createGitHubAdapter: (config: unknown) => {
            configs.github = config
          },
          createTelegramAdapter: (config: unknown) => {
            configs.telegram = config
          },
        }
      },
    })

    expect(configs).toStrictEqual({ github: undefined, telegram: { botToken: "bot", secretToken: "secret" } })
  })

  test("refuses to build a bot when Telegram ingress is enabled without a webhook secret", async () => {
    const loaded: string[] = []

    await expect(createChatSdkBot({
      registrations: [{ ...registrations[1], adapterConfig: { botToken: "bot" } }],
      userName: "claxedo",
      async importer(specifier) {
        loaded.push(specifier)
        return { Chat: FakeChat }
      },
    })).rejects.toThrow(/TELEGRAM_WEBHOOK_SECRET_TOKEN/)

    expect(loaded).toEqual([])
  })

  test("registers Chat SDK handlers against the channel core", async () => {
    let mention: ((
      thread: { id: string; adapter: { name: string }; post: (text: string) => void },
      message: { id: string; text: string; author: { userId: string }; raw: unknown },
    ) => Promise<void>) | undefined
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
    await mention?.({ id: "chat", adapter: { name: "telegram" }, post: (text) => posts.push(text) }, {
      id: "msg",
      text: "hello",
      author: { userId: "4242" },
      raw: { from: { id: 4242 }, chat: { id: 4242 } },
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
            Chat: FakeChat,
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
            Chat: FakeChat,
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
            Chat: FakeChat,
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

/**
 * These run the real `chat` SDK and the real `@chat-adapter/telegram`, because
 * the defect being covered lives in what the adapter is constructed with: a fake
 * factory would accept any configuration and report nothing.
 */
describe("Telegram webhook verification through @chat-adapter/telegram", () => {
  const update = {
    update_id: 4200,
    message: {
      message_id: 7,
      date: 1_700_000_000,
      // A negative chat id is a group; a private chat would make the adapter
      // send a typing action to the Bot API before the update is processed.
      chat: { id: -1001, type: "supergroup", title: "ops" },
      from: { id: 99, is_bot: false, first_name: "Ada", username: "ada" },
      text: "@claxedo status",
      entities: [{ type: "mention", offset: 0, length: 8 }],
    },
  }

  async function post(input: { env: Record<string, string | undefined>; secretHeader?: string }) {
    const handleInbound = vi.fn(async () => {})
    const registry = createChannelRegistry(input.env)
    const bot = await createChatSdkChannelBot({
      registrations: registry.registrations,
      userName: "claxedo",
      core: { handleInbound, onApproval: vi.fn(async () => ({ ok: true as const })) },
    })
    const pending: Promise<unknown>[] = []
    const response = await bot.webhooks?.telegram?.(
      new Request("https://claxedo.test/telegram", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(input.secretHeader === undefined ? {} : { "x-telegram-bot-api-secret-token": input.secretHeader }),
        },
        body: JSON.stringify(update),
      }),
      { waitUntil: (task) => pending.push(task) },
    )
    await Promise.all(pending)
    return { status: response?.status, handleInbound }
  }

  let botApiFetch: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // The adapter falls back to process.env for whatever its config omits, and
    // its getMe/getWebhookInfo calls on the first webhook would otherwise ask
    // the real Bot API about a fabricated token.
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET_TOKEN", undefined)
    vi.stubEnv("TELEGRAM_BOT_TOKEN", undefined)
    botApiFetch = vi.fn(async () => {
      throw new Error("no network in tests")
    })
    vi.stubGlobal("fetch", botApiFetch)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  test("accepts a correctly signed update when only the canonical keys are set", async () => {
    const { status, handleInbound } = await post({
      env: { TELEGRAM_BOT_TOKEN: "canonical-bot", TELEGRAM_WEBHOOK_SECRET_TOKEN: "canonical-secret" },
      secretHeader: "canonical-secret",
    })

    expect(status).toBe(200)
    expect(handleInbound).toHaveBeenCalledWith(expect.objectContaining({ text: "@claxedo status" }), expect.any(Object))
  })

  test("accepts a correctly signed update when only the CLAXEDO_CHANNEL aliases are set", async () => {
    const { status, handleInbound } = await post({
      env: {
        CLAXEDO_CHANNEL_TELEGRAM_BOT_TOKEN: "alias-bot",
        CLAXEDO_CHANNEL_TELEGRAM_WEBHOOK_SECRET_TOKEN: "alias-secret",
      },
      secretHeader: "alias-secret",
    })

    expect(status).toBe(200)
    expect(handleInbound).toHaveBeenCalledWith(expect.objectContaining({ text: "@claxedo status" }), expect.any(Object))
  })

  test("rejects an alias-configured update carrying the wrong secret", async () => {
    const { status, handleInbound } = await post({
      env: {
        CLAXEDO_CHANNEL_TELEGRAM_BOT_TOKEN: "alias-bot",
        CLAXEDO_CHANNEL_TELEGRAM_WEBHOOK_SECRET_TOKEN: "alias-secret",
      },
      secretHeader: "forged-secret",
    })

    expect(status).toBe(401)
    expect(handleInbound).not.toHaveBeenCalled()
  })

  test("rejects an alias-configured update carrying no secret header", async () => {
    const { status, handleInbound } = await post({
      env: {
        CLAXEDO_CHANNEL_TELEGRAM_BOT_TOKEN: "alias-bot",
        CLAXEDO_CHANNEL_TELEGRAM_WEBHOOK_SECRET_TOKEN: "alias-secret",
      },
    })

    expect(status).toBe(401)
    expect(handleInbound).not.toHaveBeenCalled()
  })

  test("refuses an explicitly enabled Telegram channel whose bot token is unresolved, and never falls back to process.env", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "process-env-bot")
    const registry = createChannelRegistry({
      CLAXEDO_CHANNEL_TELEGRAM_ENABLED: "1",
      TELEGRAM_WEBHOOK_SECRET_TOKEN: "canonical-secret",
    })
    expect(registry.byPath.get("/telegram")).toMatchObject({
      enabled: true,
      adapterConfig: { botToken: undefined, secretToken: "canonical-secret" },
    })

    await expect(createChatSdkChannelBot({
      registrations: registry.registrations,
      userName: "claxedo",
      core: { handleInbound: vi.fn(async () => {}), onApproval: vi.fn(async () => ({ ok: true as const })) },
    })).rejects.toThrow(/TELEGRAM_BOT_TOKEN/)

    // getMe is the adapter's first call once it is constructed with a token.
    expect(botApiFetch).not.toHaveBeenCalled()
  })

  test("mounts no Telegram webhook at all when no secret is configured", async () => {
    const { status, handleInbound } = await post({
      env: { TELEGRAM_BOT_TOKEN: "canonical-bot" },
      secretHeader: "anything",
    })

    expect(status).toBeUndefined()
    expect(handleInbound).not.toHaveBeenCalled()
  })
})
