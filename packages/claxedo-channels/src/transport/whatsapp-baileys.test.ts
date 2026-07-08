import { afterEach, describe, expect, test, vi } from "vitest"
import { createWhatsAppBaileysTransport, type WhatsAppBaileysInboundMessage, type WhatsAppBaileysSocket } from "./whatsapp-baileys"
import type { ChannelCore } from "../core/command-emit"

afterEach(() => {
  vi.useRealTimers()
})

function socket() {
  const messages: string[] = []
  const handlers: ((message: WhatsAppBaileysInboundMessage) => Promise<void> | void)[] = []
  const authHandlers: ((state: unknown) => void)[] = []
  const api: WhatsAppBaileysSocket & {
    messages: string[]
    emit: (message: WhatsAppBaileysInboundMessage) => Promise<void>
    emitAuth: (state: unknown) => void
  } = {
    messages,
    onMessage(handler) {
      handlers.push(handler)
      return () => handlers.splice(handlers.indexOf(handler), 1)
    },
    onAuthState(handler) {
      authHandlers.push(handler)
      return () => authHandlers.splice(authHandlers.indexOf(handler), 1)
    },
    sendMessage(_chatId, text) {
      messages.push(text)
    },
    async emit(message) {
      await Promise.all(handlers.map((handler) => handler(message)))
    },
    emitAuth(state) {
      for (const handler of authHandlers) handler(state)
    },
  }
  return api
}

describe("createWhatsAppBaileysTransport", () => {
  test("normalizes inbound socket messages and renders replies over the same chat", async () => {
    const sock = socket()
    const core: ChannelCore = {
      async handleInbound(input, handlers) {
        expect(input).toMatchObject({
          channel: "whatsapp",
          externalUserId: "user@s.whatsapp.net",
          threadKey: "whatsapp:device-1:chat@s.whatsapp.net:chat@s.whatsapp.net",
          idempotencyKey: "wamid-1",
          text: "repo:acme/tools hello",
          receivedAt: 1_000_000,
          intent: { kind: "message" },
          repo: { owner: "acme", name: "tools" },
        })
        await handlers.reply({ kind: "text", text: "ok", final: true })
      },
      async onApproval() {
        return { ok: true }
      },
    }
    const transport = createWhatsAppBaileysTransport({ core, socket: sock, deviceId: "device-1" })

    await transport.start()
    await sock.emit({
      id: "wamid-1",
      chatId: "chat@s.whatsapp.net",
      senderId: "user@s.whatsapp.net",
      text: " repo:acme/tools hello ",
      timestamp: 1000,
    })

    expect(sock.messages).toEqual(["ok"])
  })

  test("ignores self messages and empty text", async () => {
    const sock = socket()
    const core: ChannelCore = {
      handleInbound: vi.fn(async () => {}),
      async onApproval() {
        return { ok: true }
      },
    }
    const transport = createWhatsAppBaileysTransport({ core, socket: sock })

    await transport.start()
    await sock.emit({ id: "self", chatId: "chat", text: "hello", fromMe: true })
    await sock.emit({ id: "empty", chatId: "chat", text: " " })

    expect(core.handleInbound).not.toHaveBeenCalled()
  })

  test("retries final replies before falling back", async () => {
    const messages: string[] = []
    const sock = {
      onMessage() {},
      sendMessage(_chatId: string, text: string) {
        messages.push(text)
        if (messages.length <= 3) throw new Error("send failed")
      },
    } satisfies WhatsAppBaileysSocket
    const transport = createWhatsAppBaileysTransport({
      core: {
        async handleInbound(_input, handlers) {
          await handlers.reply({ kind: "status", phase: "done", sessionId: "ses_1", appUrl: "/s/ses_1" })
        },
        async onApproval() {
          return { ok: true }
        },
      },
      socket: sock,
      retryDelayMs: 0,
    })

    await transport.handleMessage({ id: "msg-1", chatId: "chat", text: "hello" })

    expect(messages).toEqual([
      "Session ses_1 finished.\nOpen: /s/ses_1",
      "Session ses_1 finished.\nOpen: /s/ses_1",
      "Session ses_1 finished.\nOpen: /s/ses_1",
      "Run status changed. Open: /s/ses_1",
    ])
  })

  test("honors retry-after backpressure before retrying final socket replies", async () => {
    vi.useFakeTimers()
    const messages: string[] = []
    const transport = createWhatsAppBaileysTransport({
      core: {
        async handleInbound(_input, handlers) {
          await handlers.reply({ kind: "text", text: "done", final: true })
        },
        async onApproval() {
          return { ok: true }
        },
      },
      socket: {
        onMessage() {},
        sendMessage(_chatId, text) {
          messages.push(text)
          if (messages.length === 1) throw { retryAfterMs: 1200 }
        },
      },
    })

    const sent = transport.handleMessage({ id: "msg-1", chatId: "chat", text: "hello" })
    await Promise.resolve()

    expect(messages).toEqual(["done"])

    vi.advanceTimersByTime(1199)
    await Promise.resolve()
    expect(messages).toEqual(["done"])

    vi.advanceTimersByTime(1)
    await Promise.resolve()
    await sent

    expect(messages).toEqual(["done", "done"])
  })

  test("treats non-final socket replies as single-attempt best effort", async () => {
    const messages: string[] = []
    const sock = {
      onMessage() {},
      sendMessage(_chatId: string, text: string) {
        messages.push(text)
        throw new Error("send failed")
      },
    } satisfies WhatsAppBaileysSocket
    const transport = createWhatsAppBaileysTransport({
      core: {
        async handleInbound(_input, handlers) {
          await handlers.reply({ kind: "text", text: "draft", final: false })
        },
        async onApproval() {
          return { ok: true }
        },
      },
      socket: sock,
    })

    await expect(transport.handleMessage({ id: "msg-1", chatId: "chat", text: "hello" })).resolves.toBeUndefined()

    expect(messages).toEqual(["draft"])
  })

  test("coalesces non-final socket replies to the latest draft", async () => {
    const messages: string[] = []
    const transport = createWhatsAppBaileysTransport({
      core: {
        async handleInbound(_input, handlers) {
          await handlers.reply({ kind: "text", text: "draft 1", final: false })
          await handlers.reply({ kind: "text", text: "draft 2", final: false })
          await handlers.reply({ kind: "text", text: "done", final: true })
        },
        async onApproval() {
          return { ok: true }
        },
      },
      socket: {
        onMessage() {},
        sendMessage(_chatId, text) {
          messages.push(text)
        },
      },
    })

    await transport.handleMessage({ id: "msg-1", chatId: "chat", text: "hello" })

    expect(messages).toEqual(["draft 2", "done"])
  })

  test("swallows failed fallback sends after reliable socket retries are exhausted", async () => {
    const messages: string[] = []
    const transport = createWhatsAppBaileysTransport({
      core: {
        async handleInbound(_input, handlers) {
          await handlers.reply({ kind: "status", phase: "done", sessionId: "ses_1", appUrl: "/s/ses_1" })
        },
        async onApproval() {
          return { ok: true }
        },
      },
      socket: {
        onMessage() {},
        sendMessage(_chatId, text) {
          messages.push(text)
          throw new Error("offline")
        },
      },
      retryDelayMs: 0,
    })

    await expect(transport.handleMessage({ id: "msg-1", chatId: "chat", text: "hello" })).resolves.toBeUndefined()

    expect(messages).toEqual([
      "Session ses_1 finished.\nOpen: /s/ses_1",
      "Session ses_1 finished.\nOpen: /s/ses_1",
      "Session ses_1 finished.\nOpen: /s/ses_1",
      "Run status changed. Open: /s/ses_1",
    ])
  })

  test("applies data minimization to socket replies", async () => {
    const messages: string[] = []
    const transport = createWhatsAppBaileysTransport({
      core: {
        async handleInbound(_input, handlers) {
          await handlers.reply({
            kind: "text",
            text: `token github_pat_${"a".repeat(30)} ${"x".repeat(120)}`,
            final: true,
          })
        },
        async onApproval() {
          return { ok: true }
        },
      },
      socket: {
        onMessage() {},
        sendMessage(_chatId, text) {
          messages.push(text)
        },
      },
      dataMinimization: { maxLength: 90 },
    })

    await transport.handleMessage({ id: "msg-1", chatId: "chat", text: "hello" })

    expect(messages[0]).not.toContain(`github_pat_${"a".repeat(30)}`)
    expect(messages[0]).toContain("[redacted token]")
    expect(messages[0]).toContain("[truncated; open the session link for full output]")
    expect(messages[0].length).toBeLessThanOrEqual(90)
  })

  test("persists auth state through a debounced store hook", async () => {
    vi.useFakeTimers()
    const saves: unknown[] = []
    const sock = socket()
    const transport = createWhatsAppBaileysTransport({
      core: {
        async handleInbound() {},
        async onApproval() {
          return { ok: true }
        },
      },
      socket: sock,
      authStateDebounceMs: 1000,
      authStateStore: {
        load: () => ({ loaded: true }),
        save: (state) => saves.push(state),
      },
    })

    await transport.start()
    sock.emitAuth({ version: 1 })
    sock.emitAuth({ version: 2 })
    vi.advanceTimersByTime(999)
    await Promise.resolve()

    expect(saves).toEqual([])

    vi.advanceTimersByTime(1)
    await Promise.resolve()

    expect(saves).toEqual([{ version: 2 }])
  })
})
