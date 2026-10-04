import type {
  AuthenticationCreds,
  BaileysEventMap,
  SignalDataSet,
  SignalKeyStore,
  WAMessage,
  WASocket,
} from "@whiskeysockets/baileys"
import type { ChannelSink } from "../envelope"
import type { WhatsAppBaileysFullSocket, WhatsAppBaileysInboundMessage } from "./whatsapp-baileys"
import { record } from "../json"

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

/**
 * Baileys wrote this blob through its own `BufferJSON` codec and Baileys reads
 * it back; these guards check what this module is entitled to check — that the
 * stored value is present and is an object — and leave the field-level contract
 * to the SDK that owns it. Deliberately no stricter: requiring, say, `noiseKey`
 * would make a partially-written file trigger a fresh QR pairing instead of
 * reaching Baileys, which is a product decision, not a lint fix.
 */
function isAuthenticationCreds(value: unknown): value is AuthenticationCreds {
  return record(value) !== undefined
}

/** Every key bucket is optional, so any object is a (possibly empty) set. */
function isSignalDataSet(value: unknown): value is SignalDataSet {
  return record(value) !== undefined
}

function createStoredAuthState(baileys: BaileysModule, raw: unknown): StoredAuthState {
  const revived = raw === undefined
    ? undefined
    : JSON.parse(JSON.stringify(raw), baileys.BufferJSON.reviver)
  const row = record(revived)
  if (isAuthenticationCreds(row?.creds)) {
    return {
      creds: row.creds,
      keys: isSignalDataSet(row.keys) ? row.keys : {},
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
      const values: NonNullable<SignalDataSet[typeof type]> = input.data[type] ?? {}
      return Object.fromEntries(
        ids.flatMap((id) => {
          const value = values[id]
          return value === undefined || value === null ? [] : [[id, value]]
        }),
      )
    },
    async set(data) {
      // The merge is key-agnostic: it copies id-keyed buckets from one store
      // into the other and never inspects a value, so both stores are viewed
      // here as the string-keyed maps they are at runtime. `SignalDataSet`
      // correlates the outer key with the value type, which `Object.keys`
      // cannot carry — and this loop does not need the correlation.
      const incoming: Record<string, Record<string, unknown> | undefined> = data
      const store: Record<string, Record<string, unknown> | undefined> = input.data
      for (const type of Object.keys(incoming)) {
        const values = incoming[type]
        if (!values) continue
        const current = store[type] ?? {}
        for (const id of Object.keys(values)) {
          const value = values[id]
          if (value === null) {
            delete current[id]
            continue
          }
          current[id] = value
        }
        store[type] = current
      }
      await input.onUpdate()
    },
  }
}

/**
 * Baileys sends `messageTimestamp` as a number OR a protobuf Long. The Long
 * branch used to be dropped by a bare `typeof === "number"` check, so those
 * messages arrived with no receivedAt at all.
 */
function baileysTimestamp(input: WAMessage["messageTimestamp"]): number | undefined {
  if (typeof input === "number") return input
  const toNumber = record(input)?.toNumber
  if (typeof toNumber !== "function") return undefined
  const value: unknown = toNumber.call(input)
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function normalizeBaileysMessage(message: WAMessage): WhatsAppBaileysInboundMessage {
  return {
    id: message.key.id ?? `${message.key.remoteJid ?? "unknown"}:${baileysTimestamp(message.messageTimestamp) ?? Date.now()}`,
    chatId: message.key.remoteJid ?? "unknown",
    senderId: message.key.participant ?? message.key.remoteJid ?? undefined,
    text: baileysMessageText(message),
    timestamp: baileysTimestamp(message.messageTimestamp),
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
