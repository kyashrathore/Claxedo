/**
 * Signed-desktop SSE adapter: named stream ops through Electron main.
 *
 * Unary `AccountPort.run` cannot return a live Response body. Main opens the
 * hosted SSE with the bearer, and forwards text chunks over IPC; this module
 * reassembles them into a `Response` the existing SSE readers already consume.
 */

import { accountRunBridge } from "./hosted-control-call"
import { readBoolean } from "@/lib/record"
import { hasBridgeMembers, preloadAccountBridge } from "./preload-bridge"
import type { AccountState, HostedOperationName } from "./account-port"

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

const STREAM_MEMBERS = [
  "streamOpen",
  "streamStart",
  "streamClose",
  "onStreamChunk",
  "onStreamEnd",
  "onStreamError",
] as const satisfies readonly (keyof StreamBridge)[]

function streamBridge(): StreamBridge | undefined {
  const account = preloadAccountBridge()
  return hasBridgeMembers<StreamBridge>(account, STREAM_MEMBERS) ? account : undefined
}

/**
 * Present only when the authoritative account state is signed and Electron
 * exposes the complete stream IPC bridge. Bridge presence is a capability,
 * not evidence of a usable account: preload installs it before sign-in, keeps
 * it installed after sign-out, and installs it in unconfigured builds (no
 * `CLAXEDO_ACCOUNT_*` baked) whose every account operation refuses. Routing a
 * stream through the bridge in any of those states would loop on connect →
 * refuse → retry and no control-plane notice would ever arrive; those builds
 * keep the plain `authFetch` path against the local daemon, which serves
 * `/api/cp/events` itself.
 */
export function accountStreamAvailable(accountState: AccountState) {
  return accountState.status === "signed" && Boolean(accountRunBridge() && streamBridge())
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
              readBoolean(globalThis, "__CLAXEDO_ACCOUNT_PERF__") === true
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
