import type { ChannelCore } from "../core/command-emit"
import { parseChannelCommand } from "../core/approval-token"
import type { InboundEnvelope, OutboundChunk } from "../envelope"
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
  onMessage: (handler: (message: WhatsAppBaileysInboundMessage) => Promise<void> | void) => (() => void) | void
  onAuthState?: (handler: (state: unknown) => void) => (() => void) | void
  sendMessage: (chatId: string, text: string) => Promise<unknown> | unknown
}

export type WhatsAppBaileysAuthStateStore = {
  load: () => Promise<unknown> | unknown
  save: (state: unknown) => Promise<void> | void
}

export type WhatsAppBaileysTransport = {
  start: () => Promise<void>
  stop: () => Promise<void>
  status: () => { running: boolean }
  handleMessage: (message: WhatsAppBaileysInboundMessage) => Promise<void>
}

function receivedAt(input: WhatsAppBaileysInboundMessage["timestamp"]) {
  if (input instanceof Date) return Number.isFinite(input.getTime()) ? input.getTime() : undefined
  if (typeof input !== "number" || !Number.isFinite(input)) return undefined
  return input < 10_000_000_000 ? input * 1000 : input
}

function envelope(input: {
  message: WhatsAppBaileysInboundMessage
  deviceId: string
}): InboundEnvelope | undefined {
  const text = input.message.text?.trim()
  if (input.message.fromMe || !text) return
  const nextReceivedAt = receivedAt(input.message.timestamp)
  const repo = repoTargetFromText(text)
  return {
    channel: "whatsapp",
    externalUserId: input.message.senderId ?? input.message.chatId,
    threadKey: `whatsapp:${input.deviceId}:${input.message.chatId}:${input.message.chatId}`,
    idempotencyKey: input.message.id,
    text,
    ...(nextReceivedAt ? { receivedAt: nextReceivedAt } : {}),
    intent: parseChannelCommand(text),
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
    const next = envelope({ message, deviceId })
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
