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
  streamStart: (streamId: string) => Promise<void>
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
    "streamStart",
    "streamClose",
    "onStreamChunk",
    "onStreamEnd",
    "onStreamError",
  ] as const) {
    if (typeof account[member] !== "function") return undefined
  }
  return {
    streamOpen: account.streamOpen as StreamBridge["streamOpen"],
    streamStart: account.streamStart as StreamBridge["streamStart"],
    streamClose: account.streamClose as StreamBridge["streamClose"],
    onStreamChunk: account.onStreamChunk as StreamBridge["onStreamChunk"],
    onStreamEnd: account.onStreamEnd as StreamBridge["onStreamEnd"],
    onStreamError: account.onStreamError as StreamBridge["onStreamError"],
  }
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
  let remotelyClosed = false
  const closeRemote = () => {
    if (remotelyClosed) return
    remotelyClosed = true
    void bridge.streamClose(streamId)
  }
  let cleanupListeners = () => {}
  let streamController!: ReadableStreamDefaultController<Uint8Array>
  let terminal = false

  const terminate = (action: () => void) => {
    if (terminal) return
    terminal = true
    cleanupListeners()
    input.signal?.removeEventListener("abort", onAbort)
    closeRemote()
    action()
  }
  const onAbort = () =>
    terminate(() => streamController.error(input.signal?.reason ?? new DOMException("Aborted", "AbortError")))

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
      const encoder = new TextEncoder()
      let unsubs: Array<() => void> = []
      cleanupListeners = () => {
        for (const unsub of unsubs) unsub()
        unsubs = []
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
          terminate(() => controller.close())
        }),
        bridge.onStreamError((payload) => {
          if (payload.streamId !== streamId) return
          terminate(() => controller.error(new Error(payload.message)))
        }),
      ]
    },
    cancel() {
      terminate(() => {})
    },
  })

  if (input.signal?.aborted) {
    onAbort()
    throw input.signal.reason ?? new DOMException("Aborted", "AbortError")
  }
  input.signal?.addEventListener("abort", onAbort, { once: true })
  try {
    // Main does not touch the hosted stream until every push listener above is
    // armed. This is a protocol handshake, not an event-loop timing assumption.
    await bridge.streamStart(streamId)
  } catch (error) {
    terminate(() => streamController.error(error))
    throw error
  }

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}
