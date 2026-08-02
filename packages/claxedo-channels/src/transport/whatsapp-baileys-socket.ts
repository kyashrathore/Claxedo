import type {
  AuthenticationCreds,
  BaileysEventMap,
  SignalDataSet,
  SignalDataTypeMap,
  SignalKeyStore,
  WAMessage,
  WASocket,
} from "@whiskeysockets/baileys"
import type { ChannelSink } from "../envelope"
import type { WhatsAppBaileysFullSocket, WhatsAppBaileysInboundMessage } from "./whatsapp-baileys"

type BaileysModule = typeof import("@whiskeysockets/baileys")
type BaileysLogger = Parameters<BaileysModule["makeWASocket"]>[0]["logger"]

export type BaileysWhatsAppSocketOptions = {
  browserName?: string
  logger?: BaileysLogger
  onQr?: (qr: string) => void
  onConnectionUpdate?: (update: BaileysEventMap["connection.update"]) => void
  importer?: () => Promise<BaileysModule>
}

type StoredAuthState = {
  creds: AuthenticationCreds
  keys: SignalDataSet
}

export function createBaileysWhatsAppSocket(options: BaileysWhatsAppSocketOptions = {}): WhatsAppBaileysFullSocket {
  const state = {
    socket: undefined as WASocket | undefined,
    auth: undefined as StoredAuthState | undefined,
    messageHandlers: [] as ChannelSink<[WhatsAppBaileysInboundMessage]>[],
    authHandlers: [] as ChannelSink<[unknown]>[],
    off: [] as (() => void)[],
  }

  const emitAuthState = async (baileys: BaileysModule) => {
    if (!state.auth) return
    const snapshot = JSON.parse(JSON.stringify(state.auth, baileys.BufferJSON.replacer))
    for (const handler of state.authHandlers) handler(snapshot)
  }

  const onMessage = async (event: BaileysEventMap["messages.upsert"]) => {
    await Promise.all(event.messages.map((message) =>
      Promise.all(state.messageHandlers.map((handler) => handler(normalizeBaileysMessage(message)))),
    ))
  }

  return {
    async start(input) {
      if (state.socket) return
      const baileys = await (options.importer ?? (() => import("@whiskeysockets/baileys")))()
      state.auth = createStoredAuthState(baileys, input?.authState)
      const socket = baileys.makeWASocket({
        auth: {
          creds: state.auth.creds,
          keys: createSignalKeyStore({
            data: state.auth.keys,
            onUpdate: () => emitAuthState(baileys),
          }),
        },
        browser: baileys.Browsers.ubuntu(options.browserName ?? "Claxedo"),
        ...(options.logger ? { logger: options.logger } : {}),
      })
      const onCredsUpdate = async (update: BaileysEventMap["creds.update"]) => {
        if (!state.auth) return
        Object.assign(state.auth.creds, update)
        await emitAuthState(baileys)
      }
      const onConnectionUpdate = (update: BaileysEventMap["connection.update"]) => {
        if (update.qr) options.onQr?.(update.qr)
        options.onConnectionUpdate?.(update)
      }
      socket.ev.on("messages.upsert", onMessage)
      socket.ev.on("creds.update", onCredsUpdate)
      socket.ev.on("connection.update", onConnectionUpdate)
      state.off = [
        () => socket.ev.off("messages.upsert", onMessage),
        () => socket.ev.off("creds.update", onCredsUpdate),
        () => socket.ev.off("connection.update", onConnectionUpdate),
      ]
      state.socket = socket
    },
    async stop() {
      for (const off of state.off.splice(0)) off()
      await state.socket?.end(undefined)
      state.socket = undefined
    },
    onMessage(handler) {
      state.messageHandlers.push(handler)
      return () => state.messageHandlers.splice(state.messageHandlers.indexOf(handler), 1)
    },
    onAuthState(handler) {
      state.authHandlers.push(handler)
      return () => state.authHandlers.splice(state.authHandlers.indexOf(handler), 1)
    },
    async sendMessage(chatId, text) {
      if (!state.socket) throw new Error("WhatsApp Baileys socket is not started")
      await state.socket.sendMessage(chatId, { text })
    },
  }
}

function createStoredAuthState(baileys: BaileysModule, raw: unknown): StoredAuthState {
  const revived = raw === undefined
    ? undefined
    : JSON.parse(JSON.stringify(raw), baileys.BufferJSON.reviver)
  if (revived && typeof revived === "object" && "creds" in revived) {
    const row = revived as { creds: AuthenticationCreds; keys?: SignalDataSet }
    return {
      creds: row.creds,
      keys: row.keys ?? {},
    }
  }
  return {
    creds: baileys.initAuthCreds(),
    keys: {},
  }
}

function createSignalKeyStore(input: {
  data: SignalDataSet
  onUpdate: ChannelSink<[]>
}): SignalKeyStore {
  return {
    async get(type, ids) {
      const values = (input.data[type] ?? {}) as Record<string, SignalDataTypeMap[typeof type] | undefined>
      return Object.fromEntries(
        ids.flatMap((id) => values[id] === undefined ? [] : [[id, values[id]]]),
      ) as {
        [id: string]: SignalDataTypeMap[typeof type]
      }
    },
    async set(data) {
      for (const type of Object.keys(data) as (keyof SignalDataSet)[]) {
        const values = data[type]
        if (!values) continue
        const current = (input.data[type] ?? {}) as Record<string, SignalDataTypeMap[typeof type]>
        for (const id of Object.keys(values)) {
          const value = values[id]
          if (value === null) {
            delete current[id]
            continue
          }
          current[id] = value as never
        }
        input.data[type] = current as never
      }
      await input.onUpdate()
    },
  }
}

function normalizeBaileysMessage(message: WAMessage): WhatsAppBaileysInboundMessage {
  return {
    id: message.key.id ?? `${message.key.remoteJid ?? "unknown"}:${message.messageTimestamp ?? Date.now()}`,
    chatId: message.key.remoteJid ?? "unknown",
    senderId: message.key.participant ?? message.key.remoteJid ?? undefined,
    text: baileysMessageText(message),
    timestamp: typeof message.messageTimestamp === "number" ? message.messageTimestamp : undefined,
    fromMe: message.key.fromMe === true ? true : message.key.fromMe === false ? false : undefined,
    raw: message,
  }
}

function baileysMessageText(message: WAMessage) {
  const content = message.message?.ephemeralMessage?.message
    ?? message.message?.viewOnceMessage?.message
    ?? message.message?.viewOnceMessageV2?.message
    ?? message.message
  return content?.conversation
    ?? content?.extendedTextMessage?.text
    ?? content?.imageMessage?.caption
    ?? content?.videoMessage?.caption
    ?? content?.documentMessage?.caption
    ?? undefined
}
