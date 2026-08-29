/**
 * Signed-desktop SSE adapter: named stream ops through Electron main.
 *
 * Unary `AccountPort.run` cannot return a live Response body. Main opens the
 * hosted SSE with the bearer, and forwards text chunks over IPC; this module
 * reassembles them into a `Response` the existing SSE readers already consume.
 */

import { accountRun } from "./hosted-control-call"
import type { HostedOperationName } from "./account-port"

type StreamBridge = {
  streamOpen: (operation: string, input?: Record<string, unknown>) => Promise<{ streamId: string }>
  streamClose: (streamId: string) => Promise<void>
  onStreamChunk: (
    listener: (payload: { streamId: string; text: string; seq?: number; sentAt?: number }) => void,
  ) => () => void
  onStreamEnd: (listener: (payload: { streamId: string }) => void) => () => void
  onStreamError: (listener: (payload: { streamId: string; message: string }) => void) => () => void
}

function streamBridge(): StreamBridge | undefined {
  const account = (globalThis as { api?: { account?: Record<string, unknown> } }).api?.account
  if (!account) return undefined
  for (const member of [
    "streamOpen",
    "streamClose",
    "onStreamChunk",
    "onStreamEnd",
    "onStreamError",
  ] as const) {
    if (typeof account[member] !== "function") return undefined
  }
  return account as unknown as StreamBridge
}

/**
 * Present when the Electron account bridge exposes stream IPC. Unsigned /
 * browser builds keep `authFetch`.
 */
export function accountStreamAvailable() {
  return Boolean(accountRun() && streamBridge())
}

export async function openAccountStreamResponse(input: {
  operation: HostedOperationName
  params?: Record<string, unknown>
  signal?: AbortSignal
}): Promise<Response> {
  const bridge = streamBridge()
  if (!bridge) throw new Error("account stream bridge unavailable")

  const { streamId } = await bridge.streamOpen(input.operation, input.params ?? {})
  const openAt = performance.now()
  let firstChunk = true
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    void bridge.streamClose(streamId)
  }
  input.signal?.addEventListener("abort", close, { once: true })

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      let unsubs: Array<() => void> = []
      const cleanup = () => {
        for (const unsub of unsubs) unsub()
        unsubs = []
        close()
      }
      unsubs = [
        bridge.onStreamChunk((payload) => {
          if (payload.streamId !== streamId) return
          if (firstChunk && payload.text.length > 0) {
            firstChunk = false
            const now = performance.now()
            const detail = {
              operation: input.operation,
              streamId,
              open_to_renderer_ms: now - openAt,
              ...(typeof payload.sentAt === "number" ? { chunk_ipc_ms: now - payload.sentAt } : {}),
            }
            // Diagnostics only when main armed CLAXEDO_ACCOUNT_PERF (sentAt present)
            // or a harness sets this flag in the renderer.
            if (
              typeof payload.sentAt === "number" ||
              (globalThis as { __CLAXEDO_ACCOUNT_PERF__?: boolean }).__CLAXEDO_ACCOUNT_PERF__
            ) {
              console.debug("[account-perf]", "account.stream_open_to_renderer_first_byte_ms", detail)
            }
          }
          controller.enqueue(encoder.encode(payload.text))
        }),
        bridge.onStreamEnd((payload) => {
          if (payload.streamId !== streamId) return
          cleanup()
          try {
            controller.close()
          } catch {
            // already closed
          }
        }),
        bridge.onStreamError((payload) => {
          if (payload.streamId !== streamId) return
          cleanup()
          controller.error(new Error(payload.message))
        }),
      ]
    },
    cancel() {
      close()
    },
  })

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}
