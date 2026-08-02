import type { ChannelCore } from "../core/command-emit"
import { parseChannelCommand } from "../core/channel-command"
import type { ChannelChatType, ChannelSink, InboundEnvelope, OutboundChunk } from "../envelope"
import { sanitizeChannelText, type ChannelTextMinimizationOptions } from "../core/data-minimization"
import { channelRetryDelayMs, type RetryAfterMs } from "./backpressure"
import { channelChunkFallbackText, channelChunkText } from "./chat-sdk-render"
import { repoTargetFromText } from "./repo-target"

export type WhatsAppBaileysInboundMessage = {
  id: string
  chatId: string
  senderId?: string
  text?: string
  timestamp?: number | Date
  fromMe?: boolean
  raw?: unknown
}

export type WhatsAppBaileysSocket = {
  start?: (input?: { authState?: unknown }) => Promise<void> | void
  stop?: () => Promise<void> | void
  onMessage: (handler: ChannelSink<[WhatsAppBaileysInboundMessage]>) => (() => void) | void
  onAuthState?: (handler: ChannelSink<[unknown]>) => (() => void) | void
  sendMessage: (chatId: string, text: string) => Promise<unknown> | unknown
}

export type WhatsAppBaileysAuthStateStore = {
  load: () => Promise<unknown> | unknown
  save: ChannelSink<[unknown]>
}

/**
 * A socket that implements the whole surface, not just the required part.
 * `WhatsAppBaileysSocket` keeps `start`/`stop`/`onAuthState` optional so a
 * caller can inject a minimal stub, but any real socket has all three — saying
 * so lets callers use them without an existence check that can never fail.
 */
export type WhatsAppBaileysFullSocket = WhatsAppBaileysSocket
  & Required<Pick<WhatsAppBaileysSocket, "start" | "stop" | "onAuthState">>

export type WhatsAppBaileysTransport = {
  start: () => Promise<void>
  stop: () => Promise<void>
  status: () => { running: boolean }
  handleMessage: (message: WhatsAppBaileysInboundMessage) => Promise<void>
}

/**
 * WhatsApp encodes the surface in the JID suffix: `@g.us` is a group,
 * `@s.whatsapp.net` / `@lid` is an individual chat. Broadcast and status JIDs
 * (`@broadcast`) are multi-party too, so anything that is not a plain
 * individual JID is treated as a group.
 */
function chatType(chatId: string): ChannelChatType {
  return chatId.endsWith("@s.whatsapp.net") || chatId.endsWith("@lid") ? "dm" : "group"
}

/**
 * Baileys hands us raw text with no mention metadata, so a mention is detected
 * from the text itself. Without a configured bot name there is nothing to match,
 * and the transport reports no mentions — which under the default `mention`
 * engagement mode means group messages are ignored rather than answered
 * blindly. That is the intended posture: a personal WhatsApp bridge with no
 * declared name has no way to know it was addressed.
 */
function mentions(text: string, botName: string | undefined) {
  if (!botName?.trim()) return []
  const token = `@${botName.trim().replace(/^@/, "")}`.toLowerCase()
  return text.toLowerCase().includes(token) ? [token] : []
}

function receivedAt(input: WhatsAppBaileysInboundMessage["timestamp"]) {
  if (input instanceof Date) return Number.isFinite(input.getTime()) ? input.getTime() : undefined
  if (typeof input !== "number" || !Number.isFinite(input)) return undefined
  return input < 10_000_000_000 ? input * 1000 : input
}

function envelope(input: {
  message: WhatsAppBaileysInboundMessage
  deviceId: string
  botName?: string
}): InboundEnvelope | undefined {
  const text = input.message.text?.trim()
  if (input.message.fromMe || !text) return
  const nextReceivedAt = receivedAt(input.message.timestamp)
  const repo = repoTargetFromText(text)
  const botMentions = mentions(text, input.botName)
  return {
    channel: "whatsapp",
    externalUserId: input.message.senderId ?? input.message.chatId,
    threadKey: `whatsapp:${input.deviceId}:${input.message.chatId}:${input.message.chatId}`,
    idempotencyKey: input.message.id,
    text,
    ...(nextReceivedAt ? { receivedAt: nextReceivedAt } : {}),
    chatType: chatType(input.message.chatId),
    intent: parseChannelCommand(text, { mentions: botMentions }),
    mentions: botMentions,
    ...(repo ? { repo } : {}),
    raw: input.message.raw ?? input.message,
  }
}

async function sendWithFallback(input: {
  socket: WhatsAppBaileysSocket
  chatId: string
  chunk: OutboundChunk
  postAttempts?: number
  retryDelayMs?: number
  retryAfterMs?: RetryAfterMs
  dataMinimization?: ChannelTextMinimizationOptions
}) {
  const body = sanitizeChannelText(channelChunkText(input.chunk), input.dataMinimization)
  const fallback = sanitizeChannelText(channelChunkFallbackText(input.chunk, body), input.dataMinimization)
  const reliable = input.chunk.kind === "status" || (input.chunk.kind === "text" && input.chunk.final)
  const attempts = reliable ? Math.max(1, input.postAttempts ?? 3) : 1
  const retryDelayMs = input.retryDelayMs ?? 100
  for (const index of Array.from({ length: attempts }).keys()) {
    try {
      await input.socket.sendMessage(input.chatId, body)
      return
    } catch (error) {
      if (index < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, channelRetryDelayMs({
          error,
          attempt: index,
          retryDelayMs,
          retryAfterMs: input.retryAfterMs,
        })))
      }
    }
  }
  if (!reliable || fallback === body) return
  try {
    await input.socket.sendMessage(input.chatId, fallback)
  } catch {
    // The channel already exhausted reliable delivery; do not fail the inbound handler from fallback failure.
  }
}

export function createWhatsAppBaileysTransport(input: {
  core: ChannelCore
  socket: WhatsAppBaileysSocket
  deviceId?: string
  /** Bot name used to detect mentions in group chats (see `mentions` above). */
  botName?: string
  authStateStore?: WhatsAppBaileysAuthStateStore
  authStateDebounceMs?: number
  postAttempts?: number
  retryDelayMs?: number
  retryAfterMs?: RetryAfterMs
  dataMinimization?: ChannelTextMinimizationOptions
}): WhatsAppBaileysTransport {
  const deviceId = input.deviceId ?? "personal"
  const state = {
    running: false,
    unsubscribeMessage: undefined as (() => void) | undefined,
    unsubscribeAuth: undefined as (() => void) | undefined,
    pendingAuthState: undefined as unknown,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  }

  const flushAuthState = async () => {
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
    const pending = state.pendingAuthState
    state.pendingAuthState = undefined
    if (pending !== undefined) await input.authStateStore?.save(pending)
  }

  const queueAuthState = (next: unknown) => {
    state.pendingAuthState = next
    if (state.timer) return
    state.timer = setTimeout(() => {
      flushAuthState().catch(() => {})
    }, input.authStateDebounceMs ?? 1000)
  }

  const handleMessage = async (message: WhatsAppBaileysInboundMessage) => {
    const next = envelope({ message, deviceId, ...(input.botName ? { botName: input.botName } : {}) })
    if (!next) return
    let pendingText: OutboundChunk | undefined
    const flushPending = async () => {
      const chunk = pendingText
      pendingText = undefined
      if (!chunk) return
      await sendWithFallback({
        socket: input.socket,
        chatId: message.chatId,
        chunk,
        postAttempts: input.postAttempts,
        retryDelayMs: input.retryDelayMs,
        retryAfterMs: input.retryAfterMs,
        dataMinimization: input.dataMinimization,
      })
    }
    await input.core.handleInbound(next, {
      async reply(chunk) {
        if (chunk.kind === "text" && !chunk.final) {
          pendingText = chunk
          return
        }
        if (chunk.kind === "text" && chunk.final) await flushPending()
        await sendWithFallback({
          socket: input.socket,
          chatId: message.chatId,
          chunk,
          postAttempts: input.postAttempts,
          retryDelayMs: input.retryDelayMs,
          retryAfterMs: input.retryAfterMs,
          dataMinimization: input.dataMinimization,
        })
      },
    })
    await flushPending()
  }

  return {
    async start() {
      if (state.running) return
      state.running = true
      state.unsubscribeMessage = input.socket.onMessage(handleMessage) ?? undefined
      state.unsubscribeAuth = input.socket.onAuthState?.(queueAuthState) ?? undefined
      await input.socket.start?.({
        ...(input.authStateStore ? { authState: await input.authStateStore.load() } : {}),
      })
    },
    async stop() {
      state.running = false
      state.unsubscribeMessage?.()
      state.unsubscribeAuth?.()
      state.unsubscribeMessage = undefined
      state.unsubscribeAuth = undefined
      await flushAuthState()
      await input.socket.stop?.()
    },
    status() {
      return { running: state.running }
    },
    handleMessage,
  }
}
