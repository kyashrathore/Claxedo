import { describe, expect, test } from "vitest"
import type { SignalDataSet } from "@whiskeysockets/baileys"
import { createBaileysWhatsAppSocket } from "./whatsapp-baileys-socket"

type BaileysModule = typeof import("@whiskeysockets/baileys")

function fakeBaileys() {
  const listeners = new Map<string, ((event: unknown) => void)[]>()
  const sent: { chatId: string; message: unknown }[] = []
  const state = {
    config: undefined as { auth: { keys: { set: (data: SignalDataSet) => Promise<void> } } } | undefined,
    ended: false,
  }
  return {
    sent,
    state,
    emit(event: string, payload: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
    module: {
      BufferJSON: {
        replacer(_key: unknown, value: unknown) {
          return value
        },
        reviver(_key: unknown, value: unknown) {
          return value
        },
      },
      Browsers: {
        ubuntu(name: string) {
          return ["ubuntu", name, "1.0"]
        },
      },
      initAuthCreds() {
        return { registered: false }
      },
      makeWASocket(config: unknown) {
        state.config = config as typeof state.config
        return {
          ev: {
            on(event: string, listener: (payload: unknown) => void) {
              listeners.set(event, [...listeners.get(event) ?? [], listener])
            },
            off(event: string, listener: (payload: unknown) => void) {
              listeners.set(event, (listeners.get(event) ?? []).filter((item) => item !== listener))
            },
          },
          async sendMessage(chatId: string, message: unknown) {
            sent.push({ chatId, message })
          },
          async end() {
            state.ended = true
          },
        }
      },
    } as unknown as BaileysModule,
  }
}

describe("createBaileysWhatsAppSocket", () => {
  test("wraps Baileys events into the personal WhatsApp socket boundary", async () => {
    const baileys = fakeBaileys()
    const qrs: string[] = []
    const messages: unknown[] = []
    const authStates: unknown[] = []
    const socket = createBaileysWhatsAppSocket({
      importer: async () => baileys.module,
      onQr: (qr) => qrs.push(qr),
    })

    socket.onMessage((message) => messages.push(message))
    socket.onAuthState((state) => authStates.push(state))
    await socket.start()
    baileys.emit("connection.update", { qr: "qr-1" })
    baileys.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: {
          id: "msg-1",
          remoteJid: "chat@s.whatsapp.net",
          participant: "user@s.whatsapp.net",
          fromMe: false,
        },
        messageTimestamp: 1000,
        message: {
          conversation: "hello",
        },
      }],
    })
    baileys.emit("creds.update", { registered: true })
    await socket.sendMessage("chat@s.whatsapp.net", "reply")
    await Promise.resolve()

    expect(qrs).toEqual(["qr-1"])
    expect(messages).toEqual([{
      id: "msg-1",
      chatId: "chat@s.whatsapp.net",
      senderId: "user@s.whatsapp.net",
      text: "hello",
      timestamp: 1000,
      fromMe: false,
      raw: expect.any(Object),
    }])
    expect(authStates).toEqual([{ creds: { registered: true }, keys: {} }])
    expect(baileys.sent).toEqual([{
      chatId: "chat@s.whatsapp.net",
      message: { text: "reply" },
    }])
  })

  test("persists signal key updates through the auth-state callback", async () => {
    const baileys = fakeBaileys()
    const authStates: unknown[] = []
    const socket = createBaileysWhatsAppSocket({
      importer: async () => baileys.module,
    })

    socket.onAuthState((state) => authStates.push(state))
    await socket.start({
      authState: {
        creds: { registered: true },
        keys: {},
      },
    })
    await baileys.state.config?.auth.keys.set({
      "pre-key": {
        "1": {
          public: new Uint8Array([1]),
          private: new Uint8Array([2]),
        },
      },
    })

    expect(authStates).toEqual([{
      creds: { registered: true },
      keys: {
        "pre-key": {
          "1": {
            public: { "0": 1 },
            private: { "0": 2 },
          },
        },
      },
    }])
  })
})
