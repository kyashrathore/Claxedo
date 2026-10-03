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

export function accountEvents(bridge: AccountStreamPort): AccountEvents {
  return async ({ lastEventId, signal }) => {
    const streamId = readString(await bridge.streamOpen("controlPlane.events", lastEventId ? { lastEventId } : {}), "streamId")
    if (!streamId) throw new Error("The desktop account opened the event stream without an id")
    const encoder = new TextEncoder()
    const listeners: (() => void)[] = []
    const detach = () => listeners.splice(0).forEach((stop) => stop())
    const close = () => {
      detach()
      void bridge.streamClose(streamId).catch((error: unknown) => console.error("The account event stream could not be closed", { streamId, error }))
    }
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        listeners.push(
          bridge.onStreamChunk((payload) => {
            if (payload.streamId === streamId) controller.enqueue(encoder.encode(payload.text))
          }),
          bridge.onStreamEnd((payload) => {
            if (payload.streamId !== streamId) return
            detach()
            controller.close()
          }),
          bridge.onStreamError((payload) => {
            if (payload.streamId !== streamId) return
            detach()
            controller.error(new Error(payload.message))
          }),
        )
      },
      cancel: close,
    })
    signal.addEventListener("abort", close, { once: true })
    await bridge.streamStart(streamId)
    return new Response(body, { headers: { "content-type": "text/event-stream" } })
  }
}
