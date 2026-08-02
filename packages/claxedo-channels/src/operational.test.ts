import { describe, expect, test } from "vitest"
import { readFile } from "node:fs/promises"

async function json<T>(url: URL) {
  return JSON.parse(await readFile(url, "utf8")) as T
}

describe("channels operational guardrails", () => {
  // The Chat SDK ships `chat` and its adapters as one lockstep release train:
  // an adapter built against a different core version negotiates a protocol the
  // core does not speak. Which version they agree on is a routine upgrade
  // decision, so assert only that they agree.
  test("holds Chat SDK core and every adapter on one exact version", async () => {
    const pkg = await json<{
      dependencies: Record<string, string>
    }>(new URL("../package.json", import.meta.url))
    const specifiers = ["chat", ...Object.keys(pkg.dependencies).filter((name) => name.startsWith("@chat-adapter/"))]

    expect(specifiers.length).toBeGreaterThanOrEqual(6)
    expect(new Set(specifiers.map((name) => pkg.dependencies[name])).size).toBe(1)
    expect(specifiers.every((name) => /^\d+\.\d+\.\d+/.test(pkg.dependencies[name]))).toBe(true)
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
