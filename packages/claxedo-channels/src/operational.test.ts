import { describe, expect, test } from "vitest"
import { readFile } from "node:fs/promises"

async function json<T>(url: URL) {
  return JSON.parse(await readFile(url, "utf8")) as T
}

describe("channels operational guardrails", () => {
  test("pins Chat SDK transport packages to the same exact version", async () => {
    const pkg = await json<{
      dependencies: Record<string, string>
    }>(new URL("../package.json", import.meta.url))
    const versions = [
      pkg.dependencies.chat,
      pkg.dependencies["@chat-adapter/discord"],
      pkg.dependencies["@chat-adapter/github"],
      pkg.dependencies["@chat-adapter/slack"],
      pkg.dependencies["@chat-adapter/telegram"],
      pkg.dependencies["@chat-adapter/whatsapp"],
    ]

    expect(new Set(versions)).toEqual(new Set(["4.32.0"]))
  })

  test("pins the personal WhatsApp Baileys dependency exactly", async () => {
    const pkg = await json<{
      dependencies: Record<string, string>
    }>(new URL("../package.json", import.meta.url))

    expect(pkg.dependencies["@whiskeysockets/baileys"]).toBe("7.0.0-rc13")
  })

  test("keeps GitHub and Telegram handlers thin over the shared core", async () => {
    const handlers = [
      new URL("./transport/github.ts", import.meta.url),
      new URL("./transport/telegram.ts", import.meta.url),
    ]

    for (const handler of handlers) {
      expect((await readFile(handler, "utf8")).split("\n").filter((line) => line.trim()).length).toBeLessThan(150)
    }
  })

  test("smoke-tests installed Chat SDK surfaces used by the bridge", async () => {
    const chatModule = await import("chat") as Record<string, unknown>
    const Chat = chatModule.Chat
    expect(typeof Chat).toBe("function")

    const bot = new (Chat as new (input: {
      userName: string
      adapters: Record<string, unknown>
    }) => Record<string, unknown>)({
      userName: "claxedo",
      adapters: {},
    })
    expect(typeof bot.onNewMention).toBe("function")
    expect(typeof bot.onSubscribedMessage).toBe("function")
    expect(typeof bot.onAction).toBe("function")

    for (const adapter of [
      ["@chat-adapter/github", "createGitHubAdapter"],
      ["@chat-adapter/telegram", "createTelegramAdapter"],
      ["@chat-adapter/slack", "createSlackAdapter"],
      ["@chat-adapter/discord", "createDiscordAdapter"],
      ["@chat-adapter/whatsapp", "createWhatsAppAdapter"],
    ] as const) {
      expect(typeof (await import(adapter[0]) as Record<string, unknown>)[adapter[1]]).toBe("function")
    }

    expect(typeof (await import("@whiskeysockets/baileys") as Record<string, unknown>).makeWASocket).toBe("function")
  })
})
