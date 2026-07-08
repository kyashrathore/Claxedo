import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import { workspaceRuntimeBus } from "../bus"

export function runtimeBusEventsHandler() {
  return (c: Context) => streamSSE(c, async (stream) => {
    const unsub = workspaceRuntimeBus.subscribe((event) => {
      void stream.writeSSE({ data: JSON.stringify(event) })
    })

    const hb = setInterval(() => {
      void stream.writeSSE({ data: JSON.stringify({ type: "heartbeat" }) })
    }, 30000)

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        clearInterval(hb)
        unsub()
        resolve()
      })
    })
  })
}
