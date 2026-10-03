import { readString } from "@claxedo/helpers/readers"
import type { AccountEvents } from "./config"

export type AccountStreamPort = {
  readonly streamOpen: (operation: string, input?: Readonly<Record<string, unknown>>) => Promise<unknown>
  readonly streamStart: (streamId: string) => Promise<unknown>
  readonly streamClose: (streamId: string) => Promise<unknown>
  readonly onStreamChunk: (listener: (payload: { readonly streamId: string; readonly text: string }) => void) => () => void
  readonly onStreamEnd: (listener: (payload: { readonly streamId: string }) => void) => () => void
  readonly onStreamError: (listener: (payload: { readonly streamId: string; readonly message: string }) => void) => () => void
}

function streamBody(bridge: AccountStreamPort, streamId: string, signal: AbortSignal, closeInMain: () => void) {
  const encoder = new TextEncoder()
  const listeners: (() => void)[] = []
  let body!: ReadableStreamDefaultController<Uint8Array>
  const detach = () => {
    listeners.splice(0).forEach((stop) => stop())
    signal.removeEventListener("abort", abort)
  }
  const abort = () => {
    detach()
    closeInMain()
    body.error(signal.reason)
  }
  const ended = (payload: { readonly streamId: string }, settle: () => void) => {
    if (payload.streamId !== streamId) return
    detach()
    settle()
  }
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      body = controller
      listeners.push(
        bridge.onStreamChunk((payload) => {
          if (payload.streamId === streamId) controller.enqueue(encoder.encode(payload.text))
        }),
        bridge.onStreamEnd((payload) => ended(payload, () => controller.close())),
        bridge.onStreamError((payload) => ended(payload, () => controller.error(new Error(payload.message)))),
      )
    },
    cancel: () => {
      detach()
      closeInMain()
    },
  })
  signal.addEventListener("abort", abort, { once: true })
  return stream
}

export function accountEvents(bridge: AccountStreamPort): AccountEvents {
  return async ({ lastEventId, signal }) => {
    const streamId = readString(await bridge.streamOpen("controlPlane.events", lastEventId ? { lastEventId } : {}), "streamId")
    if (!streamId) throw new Error("The desktop account opened the event stream without an id")
    const closeInMain = () => {
      void bridge.streamClose(streamId).catch((error: unknown) => console.error("The account event stream could not be closed", { streamId, error }))
    }
    if (signal.aborted) {
      closeInMain()
      throw signal.reason
    }
    const body = streamBody(bridge, streamId, signal, closeInMain)
    await bridge.streamStart(streamId)
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }
}
